# Org session stores

Status: proposal. Spans dosu-cli and the Dosu backend (`backend/public_api/memory/sources.py`,
`memory.session_source`); sessiondb itself does not change.

## The problem

Where an org's sessions are kept, and how Dosu reads them, is one decision an admin makes once.
How one person's machine writes there is another, made per person. Setup today asks every person
both questions:

- `dosu setup` with your own server or your own bucket ends in "let Dosu read the bucket", so
  every member pastes Dosu's read-only key. The key is the org's, but each member holds a copy and
  each member's source carries its own.
- A self-hosted server's per-person tokens are a `name:token` list (`SESSIONDB_TOKENS`) the admin
  edits by hand and hands out.
- Nothing in Dosu says "this org keeps its sessions there", so a new member has to be told the
  server URL or bucket out of band.

Dosu's hosted sessiondb already works the right way. The backend holds the read key
(`SESSIONDB_HOSTED_*`), a member's `dosu setup` gets a token signed for their own folder
(`o-<org>.u-<user>`, 90 days, renewed by `dosu sync`), and the backend creates that member's
source itself. The member never sees a bucket credential. This proposal makes that split the
general case.

## The model

**Org session store** (one per org, set by an admin):

- `kind`: `hosted` (Dosu's), `server` (a sessiondb server the org runs), or `bucket` (a bucket
  members write to directly, redacting on their own machine).
- Where: the server URL, and the bucket it writes (from its `/v1/me`), or the bucket URL with its
  region, R2 account id or endpoint.
- Dosu's read-only key to that bucket, sealed as source credentials are today.
- Optionally an issuer: for a `server`, its `SESSIONDB_TOKEN_SECRET`, so Dosu can mint member
  tokens the way it does for hosted. sessiondb servers already accept signed tokens alongside the
  static list (sessiondb#10), so this needs no server change.

**Member credential** (one per person, for their own `owners/<owner>/` folder):

| Store | How a member gets it | Owner folder |
| --- | --- | --- |
| `hosted` | Minted by Dosu | `o-<org>.u-<user>` |
| `server` with issuer | Minted by Dosu | `o-<org>.u-<user>` |
| `server` without issuer | Pasted: a token from the admin's `SESSIONDB_TOKENS` | the name the server gives it (`/v1/me`) |
| `bucket` | The member's own write key, which the admin issues outside Dosu | `o-<org>.u-<user>` by default |

Dosu never creates cloud keys. For a bucket, scoping each key to its folder is the admin's bucket
policy.

## Enrollment

A member's `dosu setup` (logged in):

1. `GET /v1/memory/store?deployment_id=…` returns the org's store: its kind, its location, and
   whether Dosu can issue a credential. No secrets.
2. `POST /v1/memory/store/enroll` with whatever the member supplies (nothing, a server token's
   owner, or a bucket owner name). The backend:
   - creates the member's `memory.session_source` row for their owner folder with the store's
     read key, exactly as `POST /sources/hosted` does today;
   - mints a token when the store can issue one, and returns it with the location.
3. The CLI saves a target as today (a server target, or a bucket target with the member's write
   key) and ships.

The read path, `memory.session_source`, its cursors and the privacy gates are unchanged: a source
is still per member and per folder, owned by that member. What changes is who creates it: the
backend, from the org store, instead of each member with a pasted read key.

`POST /v1/memory/sources/hosted` becomes enrollment in an org whose store is `hosted`, and stays
as an alias until CLIs that call it are gone. An org without a store gets `hosted` when the
backend has it configured, so nothing changes for hosted users.

## CLI

- **`dosu setup` (member):** sign in, then read the org store.
  - `hosted`, or `server` with issuer: no questions.
  - `server` without issuer: "paste the token your admin gave you".
  - `bucket`: the write-key prompts the bucket wizard has today, with the bucket filled in.
  - No store and no hosted: say the org has no session store yet and that an admin sets it with
    `dosu sources store setup`, or offer a personal target.
  - No step in this flow asks for a read key.
- **`dosu sources store setup` (admin):** the server and bucket wizards' questions, the read key,
  and optionally the server's token secret. It checks the read key against the bucket (as connect
  does today) and saves the store. `dosu sources store status` shows it, and the members enrolled.
- **Personal targets** stay: `dosu sources setup --server …` or `--bucket …` with no login, or for
  someone whose org has no store. Without a login nothing is read by Dosu; with one, the
  per-member connect (read key and all) remains possible but is no longer what setup leads with.

## Backend

- `memory.session_store`: `org_id` (unique), `kind`, location columns as on `session_source`,
  `encrypted_read_credentials`, `encrypted_issuer_secret` (nullable), audit columns.
- `memory.session_source.store_id` (nullable): which store a source was enrolled from, so
  re-keying the store re-keys its sources, and removing a member removes their source.
- Endpoints: `GET /store`, `PUT /store` (org admins only), `POST /store/enroll`.
- Owner names are unique per store: a second member claiming an owner already enrolled is
  refused. For minted tokens the owner is fixed by Dosu. For pasted server tokens and bucket
  keys, Dosu cannot prove which folder a person may write, so first-come and an admin-visible
  member list are the guard (see open questions).

## Security

- Members hold only what they write with. The read key and the issuer secret stay in the backend.
- Rotating the read key is one `PUT /store`, not one reconnect per member.
- A pasted token or bucket key is the admin's to scope and revoke. Dosu's minted tokens expire
  (90 days) and are renewed by `dosu sync`, as for hosted today.

## Open source

Nothing here changes sessiondb or what dosu-cli ships without a login. sessiondb (server, SDK,
layout) and dosu-cli are MIT and work with no Dosu account: run a server with your own tokens, or
write to your own bucket, then `dosu sync`. The org store is a Dosu layer on top. The open
question is packaging: today "save your sessions" means installing a CLI named `dosu` whose setup
leads with signing in. If that matters, the hooks and shipper could later move into the sessiondb
repo behind a `sessiondb` command, with dosu-cli adding login and the org store.

## Phases

1. Backend: `session_store`, `GET`/`PUT /store`, `POST /store/enroll`, with `hosted` as the
   implicit store and `/sources/hosted` as an alias. No CLI change needed.
2. CLI member flow: `dosu setup` reads the store and enrolls; no read-key prompts.
3. CLI admin flow: `dosu sources store setup` and `status`.
4. Existing per-member sources: attach each to its org's store where the bucket matches, and stop
   leading setup with the per-member connect.

## Open questions

- Who may `PUT /store`: org admins only, or anyone until a store exists?
- Pasted tokens and bucket keys: is first-come owner naming enough, or should a member's owner
  need an admin's approval before Dosu reads it?
- One store per org, or several (for example one per team) later? The table allows adding a name
  and dropping the unique `org_id` without changing enrollment.
