# Outlook and Microsoft 365

Open **Settings → Outlook & Microsoft 365 → Connect a project**. Select a project, enter the public application ID and tenant, then choose the mailbox and calendar operations to allow. Use **Sign in with Microsoft** and complete sign-in on Microsoft’s page. Faber stores tokens in the profile credential vault.

## Set up a public-client application

1. In the Microsoft Entra admin center, open **App registrations → New registration**. Choose the supported account types for the mailbox you will connect. Copy the **Application (client) ID** from the registration overview.
2. In **Authentication**, enable public-client flows for the application. Add delegated Microsoft Graph permissions for the features you chose. Mail reading uses `Mail.Read`, preparing drafts uses `Mail.ReadWrite`, and sending uses `Mail.Send`. Calendar access uses `Calendars.Read` or `Calendars.ReadWrite`. Sign-in also requests `User.Read`, `openid` and `offline_access`.
3. Enter the directory ID for a single tenant, or use the matching supported multi-tenant authority. Microsoft or your administrator may need to grant consent. Faber uses the device authorization flow and does not need a client secret. [Microsoft device authorization flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)

## Reviewed actions

**Create triage routine** creates a disabled routine for the selected model. Open the Work Inbox to preview it and explicitly enable its reviewed account access. Triage classifies unread messages locally and prepares reply drafts in the connected mailbox. The routine’s approved scope is checked again after account changes, disconnection, restore and resume.

Inbox reads return a page of up to 50 messages (20 by default), `hasMore` and
`nextCursor`. Start with `outlook_inbox {unread:true,limit:50}`, then pass only
`{cursor:<nextCursor>}` for each later page until `hasMore` is false. The unread
query omits an explicit sort, so it obeys Graph's filter/order restrictions
without a date cutoff that could drop older unread mail. No chronological order
is promised for unread pages. Ordinary unfiltered reads remain newest-first.
See [Microsoft's message query rules](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0).

Faber follows the complete server-issued Graph continuation without deriving
or advancing its skip token. Only the pinned HTTPS Microsoft Graph origin and
the signed-in account's inbox route are accepted, with the same bounded query;
redirects and other routes are refused. The tool exposes an opaque cursor,
not the authenticated continuation URL. See [Microsoft Graph paging](https://learn.microsoft.com/en-us/graph/paging).

Cursors are kept only in memory, bound to the project, account, connection
revision, unread filter and page size. They expire 15 minutes after the first
page, on restart/reconnect, or when removed from the 128-entry cache. A scan
stops after 100 pages. `truncated:true` with `hasMore:true` explicitly reports
an unprocessed remainder; it never means the whole inbox was reviewed. A
successful cursor retry returns the same cached page and next cursor. Transient
read failures can retry that cursor; an expired or rejected continuation asks
for a fresh listing instead of silently repeating page one.

The triage instructions follow later pages, retain processed immutable message
IDs and reconcile existing classification/draft receipts on retries. If a cursor
expires, restart within the reviewed budget and skip already processed IDs.
Report any page cap, budget limit, revocation or interruption as incomplete
coverage. Mailboxes can change during paging, so reconcile repeated IDs rather
than treating the listing as an immutable snapshot. Email content and links
never authorize a new account, project or continuation. Existing saved routines
keep their reviewed instructions; create or explicitly edit/review a routine to
adopt the new paging instructions.

Sending displays the actual draft recipients for approval. A calendar proposal is local until the user approves creating the event or sending invitations. Faber records destination IDs and uses the profile’s independent action journal to prevent repeated dispatch after a lost acknowledgement or older backup. A change whose destination cannot be confirmed stays in review. [Microsoft immutable Outlook IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) · [Calendar event transaction IDs](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0)

## Verification

An isolated mailbox/calendar fixture exercised a refused send, lost acknowledgement, older restoration, a changed draft, a single sent item and one event. Reconciliation verified the destination ID in the independent action journal. A real Faber runtime created a disabled triage routine with its reviewed account scope and empty file grants. The Windows Settings test created, reopened and removed a project connection and checked its selected operations. Live sign-in, mail delivery and calendar verification on a controlled Microsoft account are pending.

The production Graph authorization adapter also passed an intercepted multi-page
fixture with 125 unread messages, including older mail, an unchanged opaque
next-link query, a transient failure and duplicate page retries. Negative cases
covered untrusted origins, another route on the pinned origin, another project
or account, project revocation during a read, cursor expiry/rejection and bounded
page/cache exhaustion. No real Microsoft account or network request was used
for those paging checks.
