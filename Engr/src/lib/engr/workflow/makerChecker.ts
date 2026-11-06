/** Pure maker/checker rules shared by approval workflows and regression tests. */
export function independentActor(
  actorId: string,
  submittedBy: string | null,
  createdBy: string | null,
): boolean {
  const maker = submittedBy ?? createdBy;
  return maker == null || maker !== actorId;
}

export function scheduleMayActivate(actorId: string, createdBy: string | null): boolean {
  return createdBy == null || createdBy !== actorId;
}
