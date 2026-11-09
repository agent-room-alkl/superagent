# Microsoft 365 knowledge sources: minimum Entra permissions

These are the least privileges the mail and SharePoint/OneDrive knowledge plugins need (PRD §3.2). Both plugins only
issue `GET` requests to Microsoft Graph. Write permissions are never requested.

## App registration

Create **one app registration per customer tenant**, used only for knowledge ingestion. Do not reuse the sign-in app
(`ENTRA_CLIENT_ID`) for this.

| Item | Value |
|---|---|
| Supported account types | This organisation only (single tenant) |
| Credential | A certificate stored in the platform Key Vault. The connection's `credentialRef` holds the Key Vault name only. No client secrets. |
| Redirect URI | None (application permissions, client-credentials flow) |

## Application permissions (Microsoft Graph)

| Plugin | Permission | Why | Narrowing (required) |
|---|---|---|---|
| Historical mail | `Mail.Read` | Read messages and attachments in the chosen folder | Restrict the app to the chosen mailboxes with an Exchange Online **RBAC for Applications** role assignment (or an application access policy). Without this restriction, `Mail.Read` covers every mailbox in the tenant. |
| SharePoint / OneDrive | `Sites.Selected` | Read files, delta and item permissions on granted sites only | A SharePoint admin grants the app the `read` role on each chosen site (`POST /sites/{site-id}/permissions`). Sites with no grant are invisible. |

Requested from neither plugin: `Mail.Send`, `Mail.ReadWrite`, `Files.Read.All`, `Files.ReadWrite.*`, `Sites.Read.All`,
`Sites.ReadWrite.All`, or any delegated permission. `apps/server/test/knowledge-m365.test.ts` asserts that the mail
plugin's manifest does not list `Mail.Send` or any `ReadWrite` permission, and that every Graph call made is a `GET`.

## How access changes reach the platform

| Event in Microsoft 365 | Graph signal | Platform behaviour |
|---|---|---|
| Admin consent revoked / certificate expired | 401 on any call | Connection set to *needs re-auth*; every item suspended from retrieval and citation |
| Mailbox removed from the RBAC scope / site grant removed | 403 on the listing | Same as above |
| A single file's permissions changed | Item appears in the delta (`deltashowsharingchanges`) | ACL re-read; readers updated without re-parsing unchanged content |
| A single file no longer readable by the app | 403 on that file | That item becomes *access revoked*; anything citing it is flagged |
| Message or file deleted | `@removed` / `deleted` facet | Item (and a message's attachments) deleted from use; history kept |
| Delta token expired | 410 / `syncStateNotFound` | Full re-list and reconcile, then a fresh token |
| Throttling | 429 / 503 with `Retry-After` | Cursor not advanced; retried later |

## Readers (ACL) the platform records

- **Mail:** Graph has no per-message permissions. The readers are the audience the connection owner confirms for that
  mailbox. If no audience has been confirmed, the ACL is unknown and nothing from the mailbox is usable.
- **SharePoint:** each item's own permissions are recorded:
  - Entra users and groups are recorded by object id.
  - SharePoint site groups are recorded as `sp-group:<site>:<id>`. Retrieval must expand these. A group it cannot
    expand matches nobody, so the item is withheld rather than exposed.
  - Organisation-wide sharing links are recorded as `org:all`.
  - An **anonymous** link means the readers cannot be enumerated, so the ACL is unknown and the item is unusable.
