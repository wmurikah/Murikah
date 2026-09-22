"""Strict, offline Virtual Internship scenario-pack validation."""
from __future__ import annotations
import copy, hashlib, json
from pathlib import Path
from typing import Any

SCENARIO_SCHEMA_VERSION = 1
MAX_CANONICAL_JSON_BYTES = 1_048_576
MAX_CASCADE_DEPTH = 16
COMPONENTS = ("manifest","company","facts","actors","tasks","events","decisions")
COMPONENT_FILES = {name: f"{name}.json" for name in COMPONENTS}
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "virtual-internship" / "schema" / "v1" / "scenario-pack.schema.json"
SCENARIOS_ROOT = Path(__file__).resolve().parents[2] / "virtual-internship" / "scenarios"
TASK_STATES = {"locked","available","in_progress","completed","cancelled"}
MUTATIONS = {"reveal_fact","set_mutable_fact","unlock_task","assign_task","adjust_deadline","record_decision"}
TRIGGERS = {"time_elapsed_days","task_state","all_dependencies_completed","fact_equals","prior_event","decision"}

class ScenarioValidationError(ValueError):
    pass

def _err(path: str, message: str) -> None:
    raise ScenarioValidationError(f"{path}: {message}")

def _resolve_ref(root: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#/"):
        _err("$schema", f"unsupported ref {ref}")
    value: Any = root
    for part in ref[2:].split("/"):
        value = value[part]
    return value

def _validate_schema(value: Any, schema: dict[str, Any], root: dict[str, Any], path: str) -> None:
    if "$ref" in schema:
        return _validate_schema(value, _resolve_ref(root, schema["$ref"]), root, path)
    if "anyOf" in schema:
        errors=[]
        for candidate in schema["anyOf"]:
            try:
                _validate_schema(value,candidate,root,path); return
            except ScenarioValidationError as exc:
                errors.append(str(exc))
        _err(path,"does not match any allowed schema")
    if "const" in schema and value != schema["const"]:
        _err(path,f"must equal {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        _err(path,f"must be one of {schema['enum']!r}")
    kind=schema.get("type")
    ok = (
        kind is None or
        (kind=="object" and isinstance(value,dict)) or
        (kind=="array" and isinstance(value,list)) or
        (kind=="string" and isinstance(value,str)) or
        (kind=="integer" and isinstance(value,int) and not isinstance(value,bool)) or
        (kind=="boolean" and isinstance(value,bool)) or
        (kind=="null" and value is None)
    )
    if not ok: _err(path,f"expected {kind}")
    if isinstance(value,dict):
        required=schema.get("required",[])
        for key in required:
            if key not in value: _err(f"{path}.{key}","required field is missing")
        props=schema.get("properties",{})
        if schema.get("additionalProperties") is False:
            unknown=sorted(set(value)-set(props))
            if unknown: _err(path,f"unknown fields: {', '.join(unknown)}")
        for key,item in value.items():
            if key in props: _validate_schema(item,props[key],root,f"{path}.{key}")
    if isinstance(value,list):
        if len(value)<schema.get("minItems",0): _err(path,"contains too few items")
        if len(value)>schema.get("maxItems",10**9): _err(path,"contains too many items")
        if schema.get("uniqueItems"):
            encoded=[json.dumps(x,sort_keys=True,separators=(",",":"),ensure_ascii=False) for x in value]
            if len(encoded)!=len(set(encoded)): _err(path,"contains duplicate items")
        item_schema=schema.get("items")
        if item_schema:
            for i,item in enumerate(value): _validate_schema(item,item_schema,root,f"{path}[{i}]")
    if isinstance(value,str):
        import re
        if len(value)<schema.get("minLength",0): _err(path,"is too short")
        if len(value)>schema.get("maxLength",10**9): _err(path,"is too long")
        if schema.get("pattern") and not re.fullmatch(schema["pattern"],value): _err(path,"has invalid format")
    if isinstance(value,int) and not isinstance(value,bool):
        if value<schema.get("minimum",-10**18): _err(path,"is below minimum")
        if value>schema.get("maximum",10**18): _err(path,"is above maximum")

def _load_json(path: Path) -> Any:
    try: return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError: _err(path.name,"required component is missing")
    except json.JSONDecodeError as exc: _err(path.name,f"invalid JSON at line {exc.lineno}: {exc.msg}")

def canonical_definition(pack: dict[str,Any]) -> dict[str,Any]:
    value=copy.deepcopy(pack)
    value["manifest"]["content_hash"]=""
    return value

def canonical_bytes(pack: dict[str,Any]) -> bytes:
    return json.dumps(canonical_definition(pack),sort_keys=True,separators=(",",":"),ensure_ascii=False).encode("utf-8")

def content_hash(pack: dict[str,Any]) -> str:
    return hashlib.sha256(canonical_bytes(pack)).hexdigest()

def _unique(items:list[dict[str,Any]],key:str,component:str)->set[str]:
    values=[str(x.get(key,"")) for x in items]
    if len(values)!=len(set(values)): _err(component,f"duplicate {key}")
    return set(values)

def topological_task_order(tasks:list[dict[str,Any]]) -> list[str]:
    task_ids=_unique(tasks,"task_id","tasks.json")
    deps={t["task_id"]:list(t["dependencies"]) for t in tasks}
    for task_id,values in deps.items():
        for dep in values:
            if dep not in task_ids: _err(f"tasks.{task_id}.dependencies",f"unknown task {dep}")
            if dep==task_id: _err(f"tasks.{task_id}.dependencies","self dependency")
    incoming={k:len(v) for k,v in deps.items()}
    outgoing={k:[] for k in task_ids}
    for task_id,values in deps.items():
        for dep in values: outgoing[dep].append(task_id)
    order=[]
    ready=sorted((t for t,n in incoming.items() if n==0),key=lambda x:next(i["authored_sequence"] for i in tasks if i["task_id"]==x))
    while ready:
        node=ready.pop(0); order.append(node)
        for child in sorted(outgoing[node]):
            incoming[child]-=1
            if incoming[child]==0:
                ready.append(child); ready.sort(key=lambda x:(next(i["authored_sequence"] for i in tasks if i["task_id"]==x),x))
    if len(order)!=len(task_ids): _err("tasks.json","dependency graph contains a cycle")
    return order

def _event_dependency_cycle(events:list[dict[str,Any]]) -> None:
    ids={e["event_id"] for e in events}
    edges={e["event_id"]:{t["event_id"] for t in e["triggers"] if t["trigger_type"]=="prior_event"} for e in events}
    for event_id,deps in edges.items():
        unknown=deps-ids
        if unknown:_err(f"events.{event_id}",f"unknown prior event {sorted(unknown)[0]}")
    visiting:set[str]=set(); visited:set[str]=set()
    def visit(node:str):
        if node in visiting:_err("events.json","prior-event graph contains a cycle")
        if node in visited:return
        visiting.add(node)
        for dep in sorted(edges[node]):visit(dep)
        visiting.remove(node); visited.add(node)
    for node in sorted(ids):visit(node)

def validate_pack(pack_dir: Path, verify_hash: bool=True) -> dict[str,Any]:
    schema=_load_json(SCHEMA_PATH)
    pack={name:_load_json(pack_dir/COMPONENT_FILES[name]) for name in COMPONENTS}
    _validate_schema(pack,schema,schema,"scenario")
    manifest=pack["manifest"]
    if manifest["schema_version"]!=SCENARIO_SCHEMA_VERSION:_err("manifest.schema_version","unsupported schema version")
    required=set(manifest["required_components"])
    expected={COMPONENT_FILES[name] for name in COMPONENTS}
    if required!=expected:_err("manifest.required_components","must name exactly the Phase 2 core component files")
    if manifest["company_ref"]!=pack["company"]["organization_id"]:_err("manifest.company_ref","unknown company")
    if manifest["qualifying"]:
        if manifest["classification"]!="qualifying":_err("manifest.qualifying","qualifying=true requires qualifying classification")
        if manifest["minimum_duration_days"]<90:_err("manifest.minimum_duration_days","qualifying scenario cannot be below 90 days")
    elif manifest["classification"]=="qualifying":_err("manifest.classification","demo/test scenario cannot use qualifying classification")
    if pack["company"]["fictional"] is not True:_err("company.fictional","Phase 2 fixtures must be fictional")
    actor_ids=_unique(pack["actors"],"actor_id","actors.json")
    fact_ids=_unique(pack["facts"],"id","facts.json")
    task_ids=_unique(pack["tasks"],"task_id","tasks.json")
    event_ids=_unique(pack["events"],"event_id","events.json")
    decision_ids=_unique(pack["decisions"],"decision_id","decisions.json")
    if not set(manifest["initial_task_ids"])<=task_ids:_err("manifest.initial_task_ids","references unknown task")
    if not set(manifest["initial_event_ids"])<=event_ids:_err("manifest.initial_event_ids","references unknown event")
    authored_classes={actor["actor_class"] for actor in pack["actors"]}
    if not authored_classes<=set(manifest["available_actor_classes"]):_err("manifest.available_actor_classes","missing authored actor class")
    for fact in pack["facts"]:
        if fact["visibility"] in {"department","role"} and not fact["visibility_scopes"]:_err(f"facts.{fact['id']}.visibility_scopes","scoped visibility requires at least one scope")
        if fact["visibility"] in {"public","learner_visible","hidden_truth"} and fact["visibility_scopes"]:_err(f"facts.{fact['id']}.visibility_scopes","visibility does not accept scopes")
        if fact["future_only"] and fact["initially_revealed"]:_err(f"facts.{fact['id']}","future-only fact cannot be initially revealed")
    for actor in pack["actors"]:
        if actor["reports_to_actor_id"] and actor["reports_to_actor_id"] not in actor_ids:_err(f"actors.{actor['actor_id']}.reports_to_actor_id","unknown actor")
        if not set(actor["knowledge_fact_ids"])<=fact_ids:_err(f"actors.{actor['actor_id']}.knowledge_fact_ids","unknown fact")
        if not set(actor["allowed_event_ids"])<=event_ids:_err(f"actors.{actor['actor_id']}.allowed_event_ids","unknown event")
    for task in pack["tasks"]:
        if task["assigned_by_actor_id"] not in actor_ids:_err(f"tasks.{task['task_id']}.assigned_by_actor_id","unknown actor")
        if not set(task["stakeholder_actor_ids"])<=actor_ids:_err(f"tasks.{task['task_id']}.stakeholder_actor_ids","unknown actor")
        if not set(task["event_references"])<=event_ids:_err(f"tasks.{task['task_id']}.event_references","unknown event")
        if task["dependencies"] and task["initial_state"]!="locked":_err(f"tasks.{task['task_id']}.initial_state","dependent tasks must start locked")
    topological_task_order(pack["tasks"])
    for event in pack["events"]:
        if not set(event["actor_ids"])<=actor_ids:_err(f"events.{event['event_id']}.actor_ids","unknown actor")
        for trigger in event["triggers"]:
            tt=trigger["trigger_type"]
            if tt not in TRIGGERS:_err(f"events.{event['event_id']}.triggers","unknown trigger")
            if tt=="time_elapsed_days" and (not isinstance(trigger.get("days"),int) or isinstance(trigger.get("days"),bool) or trigger["days"]<0):_err(f"events.{event['event_id']}.triggers","time trigger requires non-negative days")
            if tt in {"task_state","all_dependencies_completed"} and trigger.get("task_id") not in task_ids:_err(f"events.{event['event_id']}.triggers","unknown task")
            if tt=="task_state" and trigger.get("status") not in TASK_STATES:_err(f"events.{event['event_id']}.triggers","invalid task status")
            if tt=="fact_equals":
                if trigger.get("fact_id") not in fact_ids:_err(f"events.{event['event_id']}.triggers","unknown fact")
                if "expected" not in trigger:_err(f"events.{event['event_id']}.triggers","fact trigger requires expected value")
            if tt=="prior_event" and trigger.get("event_id") not in event_ids:_err(f"events.{event['event_id']}.triggers","unknown event")
            if tt=="decision":
                decision=trigger.get("decision_id"); option=trigger.get("option_id")
                if decision not in decision_ids:_err(f"events.{event['event_id']}.triggers","unknown decision")
                options={o["option_id"] for d in pack["decisions"] if d["decision_id"]==decision for o in d["options"]}
                if option not in options:_err(f"events.{event['event_id']}.triggers","unknown decision option")
        for mutation in event["mutations"]:
            mt=mutation["mutation_type"]
            if mt not in MUTATIONS:_err(f"events.{event['event_id']}.mutations","unknown mutation")
            if mt in {"reveal_fact","set_mutable_fact"}:
                fact=mutation.get("fact_id")
                if fact not in fact_ids:_err(f"events.{event['event_id']}.mutations","unknown fact")
                if mt=="set_mutable_fact":
                    if "value" not in mutation:_err(f"events.{event['event_id']}.mutations","set_mutable_fact requires value")
                    target=next(f for f in pack["facts"] if f["id"]==fact)
                    if target["mutability"]!="mutable":_err(f"events.{event['event_id']}.mutations","cannot mutate immutable fact")
            if mt in {"unlock_task","assign_task","adjust_deadline"} and mutation.get("task_id") not in task_ids:_err(f"events.{event['event_id']}.mutations","unknown task")
            if mt=="adjust_deadline" and not isinstance(mutation.get("offset_days"),int):_err(f"events.{event['event_id']}.mutations","deadline mutation requires integer offset_days")
            if mt=="record_decision":
                decision=mutation.get("decision_id"); option=mutation.get("option_id")
                if decision not in decision_ids:_err(f"events.{event['event_id']}.mutations","unknown decision")
                options={o["option_id"] for d in pack["decisions"] if d["decision_id"]==decision for o in d["options"]}
                if option not in options:_err(f"events.{event['event_id']}.mutations","unknown decision option")
    for decision in pack["decisions"]:
        option_ids=[o["option_id"] for o in decision["options"]]
        if len(option_ids)!=len(set(option_ids)):_err(f"decisions.{decision['decision_id']}.options","duplicate option_id")
    _event_dependency_cycle(pack["events"])
    raw=canonical_bytes(pack)
    if len(raw)>MAX_CANONICAL_JSON_BYTES:_err("scenario","canonical definition exceeds size limit")
    actual=content_hash(pack)
    if verify_hash and manifest["content_hash"]!=actual:_err("manifest.content_hash",f"expected {actual}")
    return pack

def discover_packs(root:Path=SCENARIOS_ROOT)->list[Path]:
    return sorted(p.parent for p in root.rglob("manifest.json"))

def validate_all(root:Path=SCENARIOS_ROOT)->list[tuple[Path,str]]:
    results=[]
    for path in discover_packs(root):
        pack=validate_pack(path,verify_hash=True)
        results.append((path,content_hash(pack)))
    return results
