"""Validate compact ER plans and render complete SVG without model-written markup."""
import html
import json
import math
import re
import textwrap


class InvalidERPlan(ValueError):
    pass


def uses_er_plan(prompt, diagram_type="auto"):
    if diagram_type in {"er / data model", "database schema"}:
        return True
    return diagram_type == "auto" and bool(re.search(
        r"\bER\b|\bERD\b|entity[ -]relationship|\bdatabase\s+(?:schema|model|diagram)\b", prompt, re.I))


ER_SYSTEM_PROMPT = '''You are a database diagram planner. Return ONLY one compact JSON object.
Do not write SVG, HTML, Mermaid, SQL, markdown explanations or a reasoning trace.
Design a coherent illustrative schema for the user's request. Do not claim it represents
an existing database. Use 3-8 entities, at most 8 fields per entity, and at most 16 relationships.
Include primary keys, foreign keys and meaningful field types. Every relationship must name
existing entities and fields. For a parent-to-child 1:N relationship, from_field is the parent's
primary key and to_field is the child's foreign key. Put uncertain design choices in assumptions.
Use exactly this shape (example values describe shape only, not the requested domain):
{"title":"Title","entities":[{"id":"parent","name":"Parent","fields":[{"name":"id","type":"uuid","key":"PK"}]},{"id":"child","name":"Child","fields":[{"name":"id","type":"uuid","key":"PK"},{"name":"parent_id","type":"uuid","key":"FK"}]}],"relationships":[{"from":"parent","to":"child","from_field":"id","to_field":"parent_id","cardinality":"1:N","label":"has"}],"assumptions":["Illustrative schema; confirm business rules."]}
Allowed key values: PK, FK, PK/FK, or empty string. Allowed cardinalities: 1:1, 1:N, N:1, N:M.
Finish the entire JSON object. Prefer a concise complete schema over a long truncated one.'''


def text(value, maximum=80):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise InvalidERPlan("invalid_text_field")
    return value.strip()


def parse_plan(answer):
    start = answer.find('{')
    if start < 0:
        raise InvalidERPlan("missing_json")
    try:
        plan, _ = json.JSONDecoder().raw_decode(answer[start:])
    except (ValueError, TypeError) as exc:
        raise InvalidERPlan("incomplete_json") from exc
    if not isinstance(plan, dict):
        raise InvalidERPlan("invalid_plan")
    title = text(plan.get('title'), 100)
    entities = plan.get('entities')
    relationships = plan.get('relationships')
    if not isinstance(entities, list) or not 2 <= len(entities) <= 8:
        raise InvalidERPlan("entity_count")
    if not isinstance(relationships, list) or not 1 <= len(relationships) <= 16:
        raise InvalidERPlan("relationship_count")
    normalized, fields_by_id = [], {}
    for entity in entities:
        if not isinstance(entity, dict): raise InvalidERPlan("invalid_entity")
        eid, name = text(entity.get('id'), 64), text(entity.get('name'), 48)
        fields = entity.get('fields')
        if eid in fields_by_id or not isinstance(fields, list) or not 1 <= len(fields) <= 8:
            raise InvalidERPlan("invalid_entity_fields")
        names, rows = set(), []
        for field in fields:
            if not isinstance(field, dict): raise InvalidERPlan("invalid_field")
            fname, ftype = text(field.get('name'), 48), text(field.get('type'), 32)
            key = field.get('key', '')
            if fname in names or not isinstance(key, str) or key not in {'', 'PK', 'FK', 'PK/FK'}:
                raise InvalidERPlan("invalid_field_key")
            names.add(fname)
            rows.append({'name': fname, 'type': ftype, 'key': key})
        if not any(f['key'] in {'PK', 'PK/FK'} for f in rows):
            raise InvalidERPlan("missing_primary_key")
        fields_by_id[eid] = {f['name']: f for f in rows}
        normalized.append({'id': eid, 'name': name, 'fields': rows})
    edges = []
    for rel in relationships:
        if not isinstance(rel, dict): raise InvalidERPlan("invalid_relationship")
        src, dst = rel.get('from'), rel.get('to')
        if not isinstance(src, str) or not isinstance(dst, str) or src not in fields_by_id or dst not in fields_by_id:
            raise InvalidERPlan("unknown_entity_reference")
        sf, tf = rel.get('from_field'), rel.get('to_field')
        if not isinstance(sf, str) or not isinstance(tf, str) or sf not in fields_by_id[src] or tf not in fields_by_id[dst]:
            raise InvalidERPlan("unknown_field_reference")
        cardinality = rel.get('cardinality')
        if cardinality not in ('1:1', '1:N', 'N:1', 'N:M'):
            raise InvalidERPlan("invalid_cardinality")
        label = rel.get('label', '')
        if not isinstance(label, str) or len(label) > 48: raise InvalidERPlan("invalid_relationship_label")
        edges.append({**rel, 'label': label})
    assumptions = plan.get('assumptions', [])
    if not isinstance(assumptions, list) or len(assumptions) > 5:
        raise InvalidERPlan("invalid_assumptions")
    return {'title': title, 'entities': normalized, 'relationships': edges,
            'assumptions': [text(a, 240) for a in assumptions]}


def render_plan(plan, style="editorial"):
    dark = style == 'minimal-dark'
    paper, card, ink, muted, line = ('#172126', '#233138', '#F7F5F0', '#BBC3C6', '#7F929B') if dark else ('#F7F5F0', '#FFFFFF', '#1E2A30', '#55636A', '#89979D')
    accent = '#A9822E'
    cols = min(3, len(plan['entities']))
    width, card_width, gap = cols * 420 + 80, 320, 100
    max_fields = max(len(e['fields']) for e in plan['entities'])
    card_height = 72 + max_fields * 38
    row_pitch = card_height + 180
    rows = math.ceil(len(plan['entities']) / cols)
    names = {e['id']: e['name'] for e in plan['entities']}
    relationships = [f'{i+1}. {names[e["from"]]}.{e["from_field"]} → {names[e["to"]]}.{e["to_field"]} ({e["cardinality"]})' for i, e in enumerate(plan['relationships'])]
    footer = ['RELATIONSHIPS']
    for line_text in relationships:
        footer.extend(textwrap.wrap(line_text, width=(width-160)//7))
    if plan['assumptions']:
        footer += ['', 'ASSUMPTIONS']
        for assumption in plan['assumptions']:
            footer.extend(textwrap.wrap(assumption, width=(width-160)//7))
    footer_y = 240 + rows * row_pitch - 80
    height = footer_y + 24 * len(footer) + 50
    positions = {e['id']: (80 + (i % cols) * (card_width + gap), 240 + (i // cols) * row_pitch) for i, e in enumerate(plan['entities'])}
    esc = lambda s: html.escape(str(s), quote=True)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="er-title er-desc">',
           f'<title id="er-title">{esc(plan["title"])}</title>',
           '<desc id="er-desc">Illustrative entity relationship diagram. PK marks primary keys; FK marks foreign keys. Relationship lines are numbered and explained below.</desc>',
           f'<rect width="{width}" height="{height}" fill="{paper}"/>',
           f'<g font-family="Arial, sans-serif" fill="{ink}">',
           f'<text x="80" y="58" font-size="25" font-weight="700" textLength="{min(len(plan["title"])*14, width-160)}" lengthAdjust="spacingAndGlyphs">{esc(plan["title"])}</text>',
           f'<text x="80" y="90" font-size="14" fill="{muted}">ILLUSTRATIVE SCHEMA · PK primary key · FK foreign key · 1 one · N many</text>']
    # Route connectors through the gutters, behind the cards, with a numbered key.
    for index, edge in enumerate(plan['relationships']):
        sx, sy = positions[edge['from']]; tx, ty = positions[edge['to']]
        source_y, target_y = sy + 28, ty + 28
        lane = 18 + (index % 6) * 7
        route_y = min(sy, ty) - 24 - (index % 8) * 9
        right, left = sx + card_width + lane, tx - lane
        path = f'M {sx + card_width} {source_y} H {right} V {route_y} H {left} V {target_y} H {tx}'
        svg.append(f'<path d="{path}" fill="none" stroke="{line}" stroke-width="1.5"/>')
        svg.append(f'<circle cx="{right}" cy="{route_y}" r="10" fill="{paper}" stroke="{accent}"/>')
        svg.append(f'<text x="{right}" y="{route_y + 4}" text-anchor="middle" font-size="11">{index+1}</text>')
        start, end = edge['cardinality'].split(':')
        svg.append(f'<text x="{sx + card_width + 5}" y="{source_y-7}" font-size="12" fill="{muted}">{start}</text>')
        svg.append(f'<text x="{tx-12}" y="{target_y-7}" font-size="12" fill="{muted}">{end}</text>')
    for entity in plan['entities']:
        x, y = positions[entity['id']]
        svg.append(f'<rect x="{x}" y="{y}" width="{card_width}" height="{card_height}" rx="4" fill="{card}" stroke="{line}"/>')
        svg.append(f'<text x="{x+16}" y="{y+32}" font-size="16" font-weight="700" textLength="{min(len(entity["name"])*9, card_width-32)}" lengthAdjust="spacingAndGlyphs">{esc(entity["name"])}</text>')
        svg.append(f'<path d="M {x} {y+52} H {x+card_width}" stroke="{accent}" stroke-width="2"/>')
        for i, field in enumerate(entity['fields']):
            fy = y + 76 + i * 38
            svg.append(f'<text x="{x+12}" y="{fy}" font-size="10" fill="{accent}">{esc(field["key"])}</text>')
            svg.append(f'<text x="{x+54}" y="{fy}" font-size="12" textLength="{min(len(field["name"])*7, 248)}" lengthAdjust="spacingAndGlyphs">{esc(field["name"])}</text>')
            svg.append(f'<text x="{x+54}" y="{fy+14}" font-size="10" fill="{muted}">{esc(field["type"])}</text>')
    for i, line_text in enumerate(footer):
        svg.append(f'<text x="80" y="{footer_y+i*24}" font-size="12" fill="{muted}">{esc(line_text)}</text>')
    svg.append('</g></svg>')
    narrative = 'Illustrative schema — confirm the relationships against your business rules.\n\n' + '\n'.join(relationships)
    if plan['assumptions']:
        narrative += '\n\nAssumptions:\n' + '\n'.join('- '+a for a in plan['assumptions'])
    fence = chr(96) * 3
    return narrative + '\n\n' + fence + 'svg\n' + ''.join(svg) + '\n' + fence


def er_answer(answer, style="editorial"):
    return render_plan(parse_plan(answer), style)
