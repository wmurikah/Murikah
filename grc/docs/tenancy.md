# Tenancy: the platform owner and the instance admin

Two kinds of user sign in to Assurance OS, and they are not the same kind of
administrator. Build Prompt 38 draws the line explicitly, in one place, so no
module has to guess.

|                                      | Platform owner (Murikah Labs)                                               | Instance admin (a customer's SUPER_ADMIN) |
| ------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------- |
| Flag                                 | `users.is_platform_owner = 1`                                               | `users.is_platform_owner = 0`             |
| Pinned to an organisation            | No                                                                          | Yes, their home organisation              |
| Lands on                             | The all-instances view, `/platform`                                         | Their own dashboard                       |
| Top-left organisation line           | "All organisations" until they enter an instance, then that instance's name | Always their organisation                 |
| Instance switcher                    | Yes, and a way to leave the instance                                        | No                                        |
| Can read another organisation's data | Only by entering that instance, which is audited                            | Never                                     |

Only the flag separates them. The seeded smoke data keeps both users in the same
home organisation on the same SUPER_ADMIN role for exactly that reason: if the
two experiences ever differ for any other reason, the smoke test fails.

## Where it is enforced

The acting organisation is resolved server-side on every request, in
`src/middleware.ts`, and never from a request parameter:

- `src/lib/grc/repos/orgContext.ts` resolves it. An ordinary user always gets
  their home organisation. A platform owner gets the instance named by the
  acting cookie **only** when it is one of the active organisations on the
  platform; anything else (absent, stale, tampered, deleted, inactive) resolves
  to `null`, never to the owner's home organisation. There is no default
  instance, so no route can silently land inside one customer.
- `src/lib/grc/auth/actingOrg.ts` holds the choice in a signed, HttpOnly cookie.
  Its absence is meaningful: no cookie means no instance. `clearActingCookie`
  is how leaving works.
- The middleware turns `null` into `locals.grc.instanceSelected === false` and an
  empty `organizationId`, which matches no row. That is belt and braces: the gate
  below means no organisation-scoped query runs in that state at all, and if one
  ever did it would read nothing rather than another organisation's data.
- The instance gate, also in the middleware, sends a platform owner with no
  instance to `/platform` for a page and answers `409 {"error":"instance_required"}`
  for an API path. The mirror case keeps `/platform` to the owner: everyone else
  is redirected home.

## Adding a page or an endpoint

Everything needs an instance by default, which is the safe direction. A route
belongs in `INSTANCE_FREE_PATHS` (`src/lib/grc/routing.ts`) only when it does not
touch an organisation's data:

- the all-instances view and the two endpoints that enter and leave an instance;
- provisioning, which creates an instance rather than acting inside one;
- the account flows (change password, account security, the verification step and
  its endpoints, sign-out), which scope by the user's **home** organisation, not
  the acting one. That is why `getPasswordState` and the MFA record are read with
  `grc.homeOrganizationId`: a credential belongs to an account, not to whichever
  customer the owner happens to be visiting.

`grc/test/routing.test.ts` pins both lists, so adding a module path to the
instance-free set fails the test.

## Audit

Both ends of a visit are recorded in `audit_log` by
`src/pages/grc/api/org/switch.ts` and `src/pages/grc/api/org/leave.ts`:
`ORG.switch` when an instance is entered and `ORG.leave` when it is left, each
with the organisation as the entity and the acting organisation preserved in
`new_data` (the live `audit_log` has no `organization_id` column of its own).
The audit write is best-effort and never fails the navigation, but a failure is
logged rather than swallowed.

## Deployment note

The line is drawn entirely from `users.is_platform_owner`. Which account carries
that flag is data, not code: the platform owner is the row with the flag set, and
a customer's administrator is a row with it clear. If an environment has the flag
on the wrong row, correcting it is a one-row update, not a code change.
