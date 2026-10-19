# Mail

A small email client for Bonobo Press. It reads the emails that the Gmail plugin saves to Files, and
it lets the member and the chat agent write drafts.

This is a proof of concept.

## Setup

1. Install the Gmail plugin and let it sync. It writes the emails to `/emails/<account>/`.
2. Install Mail in the same workspace.
3. Give Mail access to the emails. Install creates a Mail service account with no access. Open the
   **Service accounts** page, choose **Manage access** on the **Mail** row, pick **File or folder**,
   enter `/emails`, choose **Can view**, and press **Save grant**.

Without step 3 the page says "Mail cannot read /emails" and lists nothing.

## What it does

- **All mail** lists the emails under `/emails/<account>/<year>/<month>/`, newest first. A row
  first shows the subject and day from the file name. Then the page reads the file, four at a
  time, to show the sender and the date.
- **Reader** shows one email. **Reply** opens a draft with the sender, the subject, and the quoted
  text.
- **Drafts** are saved in the plugin store (`drafts` collection), one owned document per draft.
  The editor saves two seconds after you stop typing. A draft holds at most 15 KB, so a reply
  quotes only the start of a long email.
  **Copy** puts the draft on the clipboard so you can paste it into Gmail.
- The page has the chat agent on the right. The agent can use these page tools while the page is
  open: `get_view`, `open_email`, `list_drafts`, `create_draft`, `update_draft`, `delete_draft`. A
  draft the agent writes opens in the page and shows an "Agent" badge.

## What it does not do

- It does not send email and does not write to Gmail. That needs a Gmail sign-in with the compose
  scope.
- Drafts are private in the page, but other plugin pages in the same installation can read the
  store. Do not keep secrets in a draft.
- The Files read API cannot read only the start of a file: it refuses a file bigger than the
  limit. So a row reads its whole file, and an email file over 128 KB cannot be opened. A fix
  needs a partial read in the Files API, or a small index file that the Gmail plugin writes.
- Emails from the same day are sorted by file name, not by time, because the file name has no time.
- The last save wins. If the member and the agent save the same draft at the same moment, one
  change is lost.

## Capabilities

| Capability | Why |
| --- | --- |
| `workspace.files.read` | Read the email files the Gmail plugin saved. |
| `plugin.data.read` | Read the drafts. |
| `plugin.data.user-write` | Save and delete drafts as the member (only the `drafts` collection). |
| `agent.page-tools` | Let the chat agent use the page tools above while a member has the page open. |

## Develop

```powershell
vp env exec pnpm install --ignore-workspace
vp env exec pnpm run typecheck
vp env exec pnpm run test:once
vp env exec pnpm run build
```

The build writes `dist/frontend/` and updates the file hashes in `bonobo.plugin.json`.
