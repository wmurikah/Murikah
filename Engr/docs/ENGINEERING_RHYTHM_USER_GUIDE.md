# Engineering Rhythm user guide

**System:** Engineering Rhythm  
**Address:** <https://engr.murikah.com>  
**Initial pilot:** Kenya  
**Audience:** Owners, administrators, engineering managers, engineers, station managers, finance controllers, contractors, technicians and viewers  
**Last updated:** 10 November 2026

This guide explains where to go, what to enter and which role completes each step. A user only sees menu items and records allowed by their role and organisation. The Hass Group tenant contains its own regions, stations and other operational records, each of which can be classified to an affiliate. The Kenya pilot should use real Kenya records only. Uganda, Tanzania and the other affiliates will be introduced after the Kenya workflow is confirmed.

## 1. Sign in for the first time

1. Open <https://engr.murikah.com>.
2. Enter the work email address and temporary password supplied by the administrator.
3. Select **Sign in**.
4. On **Create your password**, enter the temporary password again.
5. Enter a private new password of at least 12 characters, confirm it and select **Change password and continue**. Pasting from a password manager is allowed.
6. Owners and Administrators are then asked to secure the account with an authenticator:
   1. Select **Start authenticator setup**.
   2. Scan the QR code with Microsoft Authenticator, Google Authenticator or 1Password.
   3. Enter the current six-digit code.
   4. Select **Confirm and enable**.
   5. Store the recovery codes privately when the system presents them. Each recovery code works once.
7. The system opens the first page available to the assigned role.

Use **Forgot password?** on the sign-in page if the password is lost. The response is deliberately the same for every email address. If an account is locked after repeated unsuccessful attempts, wait for the lock period or contact an administrator.

Never share a personal password or authenticator code. Administrators can reset a password without seeing the old one. A reset signs out existing sessions and requires another password change at the next sign-in.

## 2. Find pages and complete actions

The left menu is divided into sections. Each section starts closed; select its heading to show its pages. Opening another section closes the first. Only sections and pages your role can use are shown.

- **Overview:** Dashboard and Report centre.
- **Operations:** Requests, Work orders, Maintenance and Assets. Station confirmations are available from Work orders; asset transfers and categories are accessed from Assets.
- **Procurement:** RFQs, LPOs, Contractors and Rate cards. The procurement approval queue is accessed from RFQs.
- **Finance:** Costs, Bills, Invoices and Payments. Mileage and cost approvals are available from Costs; bill approvals are available from Bills. Contractors see their own scoped records.
- **Service Setup:** Stations, Regions, Technicians, Engineers in charge and SLAs.
- **Administration:** Affiliates, Users, Roles, Notification settings, Security settings and Audit history. Notification delivery history remains within Audit history for authorised administrators.

On a phone, select **Menu** first. Select the organisation name or **Dashboard** to return to the home page. A gold number beside a page means you have that many items requiring action. When a menu section is closed, its number totals the pending items inside it; open the section to see which pages need attention. The counts refresh when you change pages, return to the tab or after approximately one minute. No number means nothing currently requires your action in that menu. Personal notification delivery and history still operate in the background, but a separate notification bell and Action Centre menu are no longer displayed.

Buttons only appear when the record is at the correct stage and the signed-in user is allowed to perform the action. Refresh the record before retrying a rejected or conflicting action.

## 3. Roles and boundaries

| Role                 | Main responsibilities                                                                                              | Actions the role cannot perform                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner                | Full control of one organisation, including users, roles, setup, operations, approvals, finance and audit          | Cannot bypass maker/checker controls or access another organisation unless separately authorised as a platform owner                                                                                       |
| Administrator        | Organisation administration and all operational functions                                                          | Cannot create, assign, change or remove Owner authority; cannot bypass maker/checker controls                                                                                                              |
| Engineering Manager  | Kenya operational administration, setup, routing, triage, release, engineering approvals and reporting             | Cannot assign Owner, Administrator, Engineering Manager or Financial Controller roles; cannot perform final finance approval or record payments; cannot approve work they made where maker/checker applies |
| Engineer             | Create and populate requests, RFQs, maintenance schedules, LPOs and work-order drafts; submit them for approval    | Cannot accept/reject requests, release or award RFQs, activate PM schedules, approve/issue LPOs, approve costs/bills, record payments or administer users/setup                                            |
| Station Manager      | Raise requests for assigned stations and confirm technician arrival and work closure                               | Cannot see other stations, approve engineering/procurement/finance work or change setup                                                                                                                    |
| Financial Controller | Review finance records, give final bill approval, record/reverse payments and export finance reports               | Cannot perform engineering approval, edit engineering setup or operate contractor/technician records                                                                                                       |
| Contractor           | Quote for invited RFQs, view issued LPOs, accept own work, assign own technicians, submit mileage, costs and bills | Cannot see other contractors, approve own submissions, issue LPOs or administer the organisation                                                                                                           |
| Technician           | Accept assigned work, submit JSA, start work and complete a job card                                               | Cannot see unassigned work, change contractor/setup data, price/approve costs or close work without station confirmation                                                                                   |
| Viewer               | Read organisation operations and reports                                                                           | Cannot create, edit, approve, assign, submit, pay or administer anything                                                                                                                                   |

The role controls the type of action. The linked station, contractor or technician record further limits which records that user can see.

## 4. Kenya pilot setup order

Complete setup in this order because later records depend on earlier ones:

1. Confirm the Kenya affiliate.
2. Create Kenya users and assign roles.
3. Create regions.
4. Create stations and assign station managers.
5. Create asset categories and assets.
6. Create contractors and link their portal accounts.
7. Create technicians and link their portal accounts.
8. Assign engineers in charge by station or category.
9. Create SLAs.
10. Create rate cards and rate items.
11. Review notification settings and delivery readiness.
12. Create preventive-maintenance schedules where applicable.
13. Start raising live requests.

Do not create Uganda, Tanzania or other affiliate records during the Kenya pilot.

## 5. Create and manage users

**Who can do this:** Owner and Administrator. An Engineering Manager can manage only Engineer, Station Manager, Contractor, Technician and Viewer accounts.

### Create a user with a temporary password

1. Open **Administration → Users**.
2. Select **New user**.
3. Enter **Full name**, **Email** and, if available, **Phone**.
4. Set **Status** to **Active**.
5. Enter a **Temporary password** of at least 12 characters. Pasting is allowed.
6. Under **Roles**, select the role the person will use.
7. Select **Create user**.
8. Send the email address, system address and temporary password to the person through an appropriate private channel.
9. Ask the user to sign in and replace the temporary password immediately.

Leave the temporary-password field blank only when email delivery is shown as ready and you want the system to send a single-use invitation.

### Edit, suspend or reset a user

1. Open **Administration → Users**.
2. Select the user’s name.
3. Update the name, email, phone, status or permitted roles.
4. To reset the password, enter a new value under **Reset with a temporary password**.
5. Select **Save changes**.

A role change, suspension or password reset revokes current sessions. The user must sign in again. Use **Suspended** for a temporary block and **Deactivated** when access should end.

### Important portal links

Giving someone a Contractor or Technician role does not by itself connect them to operational records:

- Link a Contractor user under **Procurement → Contractors → contractor → Portal account**.
- Link a Technician user under **Service Setup → Technicians → technician → Portal account**.
- Assign a Station Manager under **Service Setup → Stations → station → Station manager**.

One portal user can be linked to only one contractor and one technician record of the relevant type.

## 6. Platform owner: create or manage an affiliate within the group tenant

**Who can do this:** Platform Owner only.

The Kenya affiliate already exists for this pilot. Use these steps later when another affiliate is approved for rollout:

1. Confirm that you are acting in the intended organisation.
2. Open **Administration → Affiliates**.
3. Select **New affiliate**.
4. Enter the unique affiliate **Code**, for example `HPK`. The code becomes the fixed login slug and cannot be changed later.
5. Enter the affiliate **Name**.
6. Enter the two-letter **Country** code, for example `KE`, `UG` or `TZ`.
7. Enter the three-letter **Base currency**, for example `KES`, `UGX` or `TZS`.
8. Select **Create affiliate**. This records a company belonging to the current group tenant; it does not create another tenant subscription or tenant-switcher choice.

To suspend or reactivate an affiliate, select it in **Administration → Affiliates**, change **Status** and select **Save changes**. Suspending an affiliate prevents its users from signing in.

## 7. Review or create roles

**Who can do this:** Owner or Administrator. An Engineering Manager can view the role definitions but cannot alter them.

Use the nine standard roles in section 3 for the Kenya pilot. Do not change their permissions without approval from the process owner.

To create a genuinely required custom role:

1. Open **Administration → Roles**.
2. Select **New role**.
3. Enter an uppercase **Code** using letters, numbers and underscores, for example `AREA_MANAGER`. The code cannot be changed later.
4. Enter the role **Name** and optional **Description**.
5. Select **Create role**.
6. Open the new role.
7. Review each permission group and select only the actions the role needs.
8. Select **Save permissions**.
9. Open **Administration → Users**, select the person and assign the custom role.

An Administrator cannot change or assign the Owner role. Saving changes to a shared default role creates an organisation-specific copy; it does not change other affiliates.

## 8. Create or reclassify a region

**Who can do this:** Owner, Administrator or Engineering Manager.

1. Open **Service Setup → Regions**.
2. Select **New region**.
3. Enter the **Name**, for example `Nairobi`.
4. Select **Affiliate** from the existing organisations. When acting as the Hass Group owner or administrator, you can classify the region under Hass Kenya, Hass Uganda or another active Hass affiliate. Hass Group itself is the tenant, not an affiliate, and is never a dropdown choice. Ordinary affiliate users can select only their own organisation.
5. Select **Create region**. The system generates its permanent `REG-000001`-style code in the owning organisation. It cannot be edited.

To amend a region, open **Service Setup → Regions**, select its name, choose an allowed **Affiliate**, and select **Save changes**. Any legacy region still showing Unassigned must be allocated to a real affiliate before it can be saved. Affiliate classification is editable, and its linked stations are reclassified atomically. The owning tenant, region/station IDs and codes do not move or change. Complete outstanding asset transfers before reassignment. Earlier blank region codes are generated by migration 010; existing codes are retained.

## 9. Create a station

**Who can do this:** Owner, Administrator or Engineering Manager.

1. Create the region and Station Manager user first.
2. Open **Service Setup → Stations**.
3. Select **New station**.
4. Enter the station **Name**. Its permanent `STN-000001`-style code is generated automatically when saved.
5. Choose the **Affiliate** from the existing group companies, then select a **Region** assigned to that affiliate. You can leave Region unset if necessary.
6. Select the **Station manager** who will raise and confirm work for that station.
7. Enter the optional **Address**.
8. Set **Status** to **Active**.
9. Select **Base station** only when this station is an origin used for mileage.
10. Select **Create station**.

To change a station, select it in **Service Setup → Stations**, choose an actual affiliate (not Hass Group), and select a matching Region before saving. Legacy stations showing Unassigned also need an affiliate before saving. Its code and owning tenant remain unchanged; existing historical codes are preserved. Complete any pending asset transfer before reclassifying the station. Use **Inactive** instead of deleting a station with history.

## 10. Create asset categories and assets

**Who can do this:** Owner, Administrator or Engineering Manager.

### Asset category

1. Open **Operations → Assets**.
2. Select **Categories**.
3. Select **New category**.
4. Enter a unique **Code** and category **Name**.
5. Optionally select a **Parent category**.
6. Select **Create category**.

### Asset

1. Open **Operations → Assets**.
2. Select **New asset**.
3. Enter the unique **Tag** and asset **Name**.
4. Select the **Station** and optional **Category**.
5. Enter the optional manufacturer, model, serial number and install date.
6. Set **Status** to **In service**, **Faulty** or **Decommissioned**.
7. Select **Create asset**.

Accurate station and category assignment makes request routing and contractor selection work correctly. Once an asset exists, its station is read-only on the edit form. Physical changes of custody must use **Operations → Assets → Asset transfers**; simply editing an asset does not move it. A gold count on **Assets** and its **Asset transfers** button shows your pending custody decisions.

### Controlled asset transfers

A transfer passes through four stages: **Requested → Approved → Dispatched → Received**. Rejected or cancelled requests do not change the asset's official station.

1. From **Operations → Assets → Asset transfers**, select **Request transfer**, choose the asset and a different active destination station within the same affiliate, and enter a reason. Open repair requests or work orders must be resolved first.
2. An authorised Engineering Manager, Administrator or Owner **approves** the request. The requester cannot approve their own request.
3. The sending station manager (or authorised management user) confirms **dispatch**, recording the actual condition and physical serial number where available.
4. The destination station manager (or another authorised management user) confirms **receipt**. The person who dispatched the asset cannot confirm its receipt.
5. Only after receiving confirmation does the system update the official location. The transfer, all actor decisions and the old/new station and region are retained in the audit trail. Active asset-specific preventive-maintenance schedules are paused for review before further allocation.

The sidebar displays outstanding transfer actions for your permissions and assigned station. A transfer waiting for someone else's decision is visible in history but does not count as your pending action. Station and region codes do not change when records are renamed.

## 11. Create and qualify a contractor

**Who can do this:** Owner, Administrator or Engineering Manager.

1. If the contractor needs system access, create its Contractor user first.
2. Open **Procurement → Contractors**.
3. Select **New contractor**.
4. Enter the contractor **Name**.
5. Select the Contractor user under **Portal account**.
6. Enter the optional contact person, email and phone.
7. Select the contractor’s optional **Base station**.
8. Set the contractor **Status** to **Active**.
9. Select every station the contractor covers.
10. Select every asset category the contractor covers.
11. Select **Prequalified** only after the contractor is approved for invitations and assignments.
12. Select **Create contractor**.

Only an active, prequalified contractor whose coverage matches the request’s station or asset category is offered for direct assignment or an RFQ invitation.

## 12. Create a technician

**Who can do this:** Owner, Administrator, Engineering Manager or the linked Contractor for its own team.

1. Create the Technician user first if the technician will sign in.
2. Open **Service Setup → Technicians**.
3. Select **New technician**.
4. Select the **Contractor**.
5. Select the Technician user under **Portal account**.
6. Enter **Name** and optional phone and email.
7. Set **Status** to **Active**.
8. Select **Create technician**.

The technician sees only work assigned to this linked technician record.

## 13. Assign engineers in charge

**Who can do this:** Owner, Administrator or Engineering Manager.

1. Create the Engineer user and give that user the Engineer role.
2. Open **Service Setup → Engineers in charge**.
3. Under **Assign an engineer**, select the **Engineer**.
4. Under **Owns**, select **A station** or **A category**.
5. Select the relevant **Station** or **Category**.
6. Select **Add assignment**.

A station assignment takes priority over a category assignment. If neither matches, new requests route to Engineering Managers. Select **Remove** beside an assignment to end it.

## 14. Create an SLA

**Who can do this:** Owner, Administrator or Engineering Manager.

1. Open **Service Setup → SLAs**.
2. Select **New SLA**.
3. Enter the SLA **Name**.
4. Enter the **Response hours** and **Resolution hours**.
5. Select **Default SLA for new work** if it should be preselected for ordinary work.
6. Select **Create SLA**.

Keep only one intentional default and use names that users can distinguish.

## 15. Create a rate card

**Who can do this:** Owner, Administrator or Engineering Manager.

1. Open **Procurement → Rate cards**.
2. Select **New rate card**.
3. Enter the rate-card **Name**.
4. Select the optional **Contractor** when the rates apply to one contractor.
5. Enter the **Currency**, status and optional effective-from/effective-to dates.
6. Select **Create rate card**.
7. Reopen the saved rate card.
8. Under rate items, enter the item **Description**, optional asset **Category**, optional **Unit** and **Unit rate**.
9. Select **Add rate item**. Repeat for every agreed item.

Use the displayed edit and delete controls to correct items. Rates are used when pricing predefined-rate work and technician spare lines.

## 16. Configure notifications

**Who can do this:** Owner, Administrator or Engineering Manager.

1. Open **Administration → Notification settings**.
2. Review **Delivery readiness**. Production delivery and each required provider should show **Ready**.
3. In-app notifications remain enabled for all users.
4. Enable **Email** and **SMS** only for the channels the organisation intends to use.
5. Enter quiet-hour start/end times and the optional monthly SMS cap.
6. Select **Save settings**.

Provider credentials are Cloudflare secrets and are not shown in the page. If an enabled external channel is not configured, its alerts remain queued rather than being marked as delivered.

To review delivery issues, open **Administration → Audit history → Notification delivery** (requires both audit and delivery-monitor permissions). Filtered records include channel, recipient, subject/template, outcome, reason, actor and time; authentication message bodies and links are not displayed. Historical notification records remain available. Select **Retry** only for an eligible failed delivery and only after the underlying issue is corrected. Expired authentication links must be newly requested rather than replayed.

## 17. Raise and triage a request

**Who can raise:** Engineer, Engineering Manager, Station Manager, Administrator or Owner.  
**Who can accept/reject:** Engineering Manager, Administrator or Owner, using a different account from the requester.

### Raise the request

1. Open **Operations → Requests**.
2. Select **Raise a request**.
3. Select the **Station**.
4. Select the optional **Asset category** and specific **Asset or equipment**.
5. Enter a concise **Issue**.
6. Add the optional **Nature of breakdown**.
7. Select the **Priority**.
8. Select **This is a repeat call** when the same fault has recurred.
9. Optionally paste a photo/video/document link and select its attachment type.
10. Select **Submit request**.

A Station Manager can raise and view requests only for assigned stations.

### Triage the request

1. The Engineering Manager opens **Operations → Requests** and selects the request number.
2. Check the station, asset, issue, priority, attachment and assigned engineer.
3. Select **Accept request**, or enter a reason and select **Reject request**.
4. The requester cannot approve their own request. Another manager-level account must decide it.

After acceptance, use one of two routes:

- **Predefined rates:** prepare a direct work-order draft and have a different manager approve the assignment.
- **RFQ:** invite matching prequalified contractors to quote.

## 18. Create a direct work order using predefined rates

1. Open the accepted request.
2. Under **Prepare work order**, select the contractor and optional SLA.
3. Select **Save work order draft**.
4. A different Engineering Manager, Administrator or Owner opens the request.
5. Under **Approve contractor assignment**, select **Assign and notify contractor**.

The person who prepared the work order cannot approve their own contractor assignment.

## 19. Create, release and award an RFQ

### Engineer: create and submit the draft

1. Open an accepted request.
2. Under **Request quotations**, select **Raise an RFQ**.
3. Select one or more matching prequalified contractors.
4. Enter the optional quote due date.
5. Enter the approval threshold in KES. An award above the threshold requires separate procurement sign-off. Leaving it blank requires sign-off for every amount.
6. Select **Create draft**.
7. On the RFQ, confirm the due date and threshold. Select **Save draft** if either is changed.
8. Select **Submit for release**.

### Manager: release the RFQ

1. Open **Procurement → RFQs** and select the submitted RFQ.
2. Review the request, invitees, due date and threshold.
3. Select **Release to contractors**.

The account that submitted the RFQ cannot release it. A different manager-level account must release it.

### Contractor: submit a quote

1. Open **Procurement → RFQs**.
2. Select an invitation.
3. Enter the diagnosis and proposed solution.
4. Mark whether a site visit was done.
5. Enter each line-item description, quantity and unit rate; mark spare items where applicable.
6. Select **Submit quote**. To refuse, enter a reason and select the decline action instead.

Contractors see only their own invitations and quotes.

### Manager: compare and award

1. Open the RFQ after quotes arrive.
2. Expand each contractor’s line items and compare diagnosis, solution and price.
3. Select **Prefer** to record the recommended quote.
4. Select **Award** on the chosen quote.
5. If the amount is within the threshold, the system creates the work order.
6. If it is above the threshold, open **Procurement → RFQs → Procurement approvals**. A different authorised approver selects **Approve and create work order**, or records a rejection reason and selects **Reject**.

## 20. Create and issue an LPO

### Engineer: create the LPO draft

1. Open **Procurement → LPOs**.
2. Select **New LPO**.
3. Select the **Contractor** and optional **Base station**.
4. Select **Create LPO**.
5. Open the LPO and add work:
   - Select an existing work order under **Attach an existing work order**, then attach it; or
   - create an LPO work order by selecting station, optional category, optional SLA and optional mileage reference station.
6. Repeat until all intended work orders appear on the LPO.
7. Select **Submit for approval**.

### Manager: approve and issue

1. Open **Procurement → LPOs** and select the submitted LPO.
2. Check contractor, base station, total and work orders.
3. Select **Approve LPO**.
4. Select **Issue to contractor**.

The submitter cannot approve the LPO. Contractors see an LPO only after it is issued. Use **Cancel LPO** with a reason when cancellation is required. **Close LPO** becomes available only when every included work order is closed or cancelled.

### Contractor mileage claim

1. Open **Procurement → LPOs** and select the issued LPO.
2. Under mileage, select the reference station and enter the round-trip distance.
3. Select **Submit claim**.
4. The Engineering Manager opens **Finance → Costs → Mileage approvals**.
5. The manager reviews or overrides distance/rate, then selects **Approve**, or enters a reason and selects **Reject**.

## 21. Create and activate preventive maintenance

### Engineer: create the schedule

1. Open **Operations → Maintenance**.
2. Select **New schedule**.
3. Enter the schedule **Name**.
4. Select a station, asset category or both.
5. Select the frequency. Enter a day interval only for **Custom day interval**.
6. Select the assigned contractor, checklist template and SLA where available.
7. Enter the first due date.
8. Enable automated reminders only when the organisation’s plan supports them.
9. Select **Create schedule**.

### Manager: activate and allocate

1. Open **Operations → Maintenance**.
2. Find the draft/paused schedule and select **Resume** to activate it.
3. A schedule creator cannot activate their own schedule; use a different manager-level account.
4. Use **Calendar** to open a due occurrence.
5. Review its station, contractor and checklist.
6. Select **Allocate and create work order**.

Use **Pause** to stop future processing temporarily and **Archive** when a schedule should no longer be used.

## 22. Contractor and technician work-order flow

### Contractor

1. Open **Operations → Work orders**.
2. Select the notified work order.
3. Select **Accept work order**, or enter a reason and select **Reject work order**.
4. After acceptance, select a technician under **Assign a technician**.
5. Select **Assign technician**.

### Technician

1. Open **Operations → Work orders**.
2. Select the assigned work order.
3. Select **Accept assignment**, or enter a reason and select **Decline assignment**.
4. Under **Safety analysis and arrival**, enter task summary, hazards and controls.
5. Select **Submit JSA and request arrival**.

### Station Manager: confirm arrival

1. Open **Operations → Work orders → Station confirmations** and select the work order awaiting arrival confirmation.
2. Verify the technician is physically on site.
3. Select **Confirm arrival**.

### Technician: complete work

1. Reopen the work order after arrival is confirmed.
2. Select **Start work**.
3. Enter diagnosis, root cause and repair completed.
4. Add spare descriptions, rate items and quantities where applicable.
5. Select **Complete and request closure**.

### Station Manager: confirm closure

1. Open **Operations → Work orders → Station confirmations** and select the work order awaiting closure confirmation.
2. Review the diagnosis, repair and spares.
3. If the issue is resolved, select **Confirm closure**.
4. If work is incomplete, enter the reason and select **Reopen work order**.

## 23. Submit and approve costs

### Contractor

1. After a work order is closed, open **Finance → Costs**.
2. Select the closed work order and create its cost.
3. Open the cost and enter each line-item description, quantity and unit rate.
4. Select **Save items**.
5. Verify subtotal, approved mileage and total.
6. Select **Submit for approval**.
7. Use **Recall to edit** only while the system still offers it.

### Engineering Manager

1. Open **Finance → Costs → Cost approvals**.
2. Select the cost.
3. Review the work order, costing basis, line items, mileage and total.
4. Enter an optional approval comment or a clear rejection reason.
5. Select **Approve** or **Reject**.

The cost submitter cannot approve the same cost. New costs have one Engineering Manager approval stage.

## 24. Submit and approve bills

### Contractor

1. Open **Finance → Bills**.
2. Enter the period label and optional start/end dates.
3. Select **Raise bill**.
4. Open the new bill.
5. Select an approved cost under **Attach an approved cost** and select **Attach**. Repeat as needed.
6. Review subtotal, tax and total.
7. Select **Submit for approval**.

### Engineering Manager

1. Open **Finance → Bills → Bill approvals**.
2. Select the bill and review its attached costs and total.
3. Enter a comment and select **Approve** or **Reject** under **Engineering decision**.

### Financial Controller

1. Open **Finance → Bills → Bill approvals**.
2. Select a bill awaiting finance approval.
3. Review the Engineering decision, costs, total and approval trail.
4. Enter a comment and select **Approve** or **Reject** under **Finance decision**.

The submitter and prior approver cannot approve a later stage of the same bill.

## 25. Record or reverse a payment

**Who can do this:** Financial Controller, Administrator or Owner.

1. Open **Finance → Payments**.
2. Find the fully approved bill.
3. Enter the amount, optional method/reference and payment date.
4. Select **Record payment**.
5. Repeat for partial payments until the bill is fully covered. The system marks the bill paid when the total is covered.

To correct an incorrect payment, find it in the payment history and select **Reverse**. Reversing a payment can reopen a bill’s outstanding balance, so use it only for a real correction.

## 26. Reports, audit and oversight

- Open **Overview → Dashboard** to review open work, approval queues, trends and organisation charts.
- Select a count or chart segment to open the records behind it.
- Select **Export work orders** to download the organisation report when the role permits export.
- Open **Administration → Audit history** to review recorded operational actions. The **Notification delivery** filter shows delivery events, failures and retries to authorised administrators. The dedicated Delivery Monitor page has been retired.
- Use the organisation switcher only when signed in as an authorised platform owner. Confirm the acting organisation before changing data.

## 27. Standard daily routine by role

### Engineering Manager

1. Read Notifications.
2. Triage new requests.
3. Release submitted RFQs and review procurement approvals.
4. Approve/issue submitted LPOs.
5. Review PM occurrences and allocate due work.
6. Review mileage, costs and Engineering-stage bills.
7. Monitor overdue work and failed notifications.

### Engineer

1. Read Notifications and assigned requests.
2. Create and complete request/RFQ/LPO/PM drafts.
3. Submit records for the manager’s review.
4. Follow work-order progress and correct draft data before submission.

### Station Manager

1. Raise accurate requests for assigned stations.
2. Confirm only technicians who have arrived physically.
3. Verify repairs before confirming closure; reopen incomplete work with a reason.

### Contractor

1. Review RFQ invitations and work orders.
2. Quote or decline before due dates.
3. Accept work and assign technicians.
4. Submit mileage, costs and bills with complete supporting information.

### Technician

1. Review only assigned work.
2. Accept or decline promptly.
3. Submit the JSA before starting work.
4. Record diagnosis, root cause, repair and spares accurately.
5. Request closure only after work is complete.

### Financial Controller

1. Review bills that passed Engineering approval.
2. Approve or reject with a clear comment.
3. Record payments against the correct bill and reference.
4. Review the finance dashboard, payment history and audit trail.

## 28. Support information to provide

When reporting a problem, provide:

- the page name;
- the record number, such as request, RFQ, LPO, work order or bill number;
- the action selected;
- the exact message displayed;
- the approximate time; and
- the signed-in role and organisation.

Do not send passwords, authenticator codes, recovery codes or confidential provider credentials.
