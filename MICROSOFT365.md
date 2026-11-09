# Outlook and Microsoft 365

Open **Settings → Outlook & Microsoft 365 → Connect a project**. Select a project, enter the public application ID and tenant, then choose the mailbox and calendar operations to allow. Use **Sign in with Microsoft** and complete sign-in on Microsoft’s page. Faber stores tokens in the profile credential vault.

## Set up a public-client application

1. In the Microsoft Entra admin center, open **App registrations → New registration**. Choose the supported account types for the mailbox you will connect. Copy the **Application (client) ID** from the registration overview.
2. In **Authentication**, enable public-client flows for the application. Add delegated Microsoft Graph permissions for the features you chose. Mail reading uses `Mail.Read`, preparing drafts uses `Mail.ReadWrite`, and sending uses `Mail.Send`. Calendar access uses `Calendars.Read` or `Calendars.ReadWrite`. Sign-in also requests `User.Read`, `openid` and `offline_access`.
3. Enter the directory ID for a single tenant, or use the matching supported multi-tenant authority. Microsoft or your administrator may need to grant consent. Faber uses the device authorization flow and does not need a client secret. [Microsoft device authorization flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)

## Reviewed actions

**Create triage routine** creates a disabled routine for the selected model. Open the Work Inbox to preview it and explicitly enable its reviewed account access. Triage classifies unread messages locally and prepares reply drafts in the connected mailbox. The routine’s approved scope is checked again after account changes, disconnection, restore and resume.

Sending displays the actual draft recipients for approval. A calendar proposal is local until the user approves creating the event or sending invitations. Faber records destination IDs and uses the profile’s independent action journal to prevent repeated dispatch after a lost acknowledgement or older backup. A change whose destination cannot be confirmed stays in review. [Microsoft immutable Outlook IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id) · [Calendar event transaction IDs](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0)

## Verification

An isolated mailbox/calendar fixture exercised a refused send, lost acknowledgement, older restoration, a changed draft, a single sent item and one event. Reconciliation verified the destination ID in the independent action journal. A real Faber runtime created a disabled triage routine with its reviewed account scope and empty file grants. The Windows Settings test created, reopened and removed a project connection and checked its selected operations. Live sign-in, mail delivery and calendar verification on a controlled Microsoft account are pending.
