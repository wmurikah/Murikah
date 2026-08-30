/**
 * Rendering a user's organisational context as one line.
 *
 * The shape of that line is decided by `user_assignments.assignment_level`, and
 * the matching id column is the only one guaranteed to be populated. Reading
 * the affiliate unconditionally would be wrong for a GROUP or COUNTRY posting,
 * which is why this dispatches on the level rather than picking the first
 * non-null column it finds.
 *
 * An EXTERNAL user has no `user_assignments` row at all. Every one of the five
 * seeded portal users is in that position, so a null assignment is the normal
 * case here and not an error: it returns null and the caller renders nothing.
 */
import type { CmsAssignment } from './repos/identity';

/**
 * The context line, or null when there is no assignment to describe.
 *
 * A BUSINESS_UNIT posting names the affiliate as well as the unit, because the
 * unit alone is ambiguous: "Retail" exists inside more than one affiliate, and
 * the seeded Zuleika Omar is "Hass Petroleum Kenya, Retail" rather than
 * "Retail". A COUNTRY posting names the country, and GROUP names itself, since
 * a group-level posting belongs to no country.
 */
export function organisationLine(assignment: CmsAssignment | null): string | null {
  if (!assignment) return null;
  switch (assignment.level) {
    case 'GROUP':
      return 'Group';
    case 'COUNTRY':
      return assignment.countryName ?? 'Group';
    case 'AFFILIATE':
      return assignment.affiliateName ?? assignment.countryName ?? 'Group';
    case 'BUSINESS_UNIT': {
      const parts = [
        assignment.affiliateName ?? assignment.countryName,
        assignment.businessUnitName,
      ].filter((part): part is string => Boolean(part));
      return parts.length > 0 ? parts.join(', ') : 'Group';
    }
    default:
      return null;
  }
}

/**
 * Job title and context together, the form the shell greets a user with, for
 * example "Customer Service Manager, Hass Petroleum Kenya".
 *
 * Never a title on its own: there are three Finance Managers in three different
 * affiliates in the seeded data, so a bare title identifies nobody.
 */
export function assignmentSummary(assignment: CmsAssignment | null): string | null {
  if (!assignment) return null;
  const context = organisationLine(assignment);
  const parts = [assignment.jobTitle, context].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : null;
}
