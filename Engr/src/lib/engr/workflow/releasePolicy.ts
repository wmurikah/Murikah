/** Pure maker/checker and visibility rules shared by release workflows. */
export function makerMayRelease(makerUserId: string | null, actorUserId: string): boolean {
  return makerUserId !== null && makerUserId !== actorUserId;
}

export function hasBeenReleased(releasedAt: string | null): boolean {
  return releasedAt !== null && releasedAt.trim().length > 0;
}
