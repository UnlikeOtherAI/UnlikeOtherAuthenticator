# Billing admin: organisation tariffs, tariff retirement, tab cleanup

Status: contract for the 16 November 2026 work. Where this document and the code disagree while
building, report the deviation; do not silently pick one.

## 1. What changes

1. **Organisations** is a new section of Admin → Billing. An operator picks an organisation and
   edits the tariff of the organisation and of each of its teams, per product.
2. A tariff version can be **retired**. A retired version is hidden unless the operator asks to see
   retired ones, and can no longer be given to anybody. Nothing is deleted: every financial record
   that names it stays as it is. A retired version can be restored.
3. The product view is reorganised: fewer, clearer columns, one date format, one action style,
   and the standard pagination footer under every table.

Nothing here changes how tariffs are resolved or when a change starts. An assignment still starts
on the first day of the next UTC month. There is no hard delete.

## 2. API

### 2.1 Retire and restore a tariff version

- `POST /internal/admin/billing/services/:serviceId/tariffs/:tariffId/retire`
- `POST /internal/admin/billing/services/:serviceId/tariffs/:tariffId/restore`

Admin superuser. Both answer `200` with the serialised tariff and are idempotent.

- `404 BILLING_TARIFF_NOT_FOUND` when the tariff is not in that service.
- Retire: `409 BILLING_TARIFF_IN_USE` when any blocker below applies.
- One transaction that takes `lockTariffHistoryService` first.
- Stored as `billing_tariffs.retired_at` and `retired_by_email`, both null for an active version.
  A new migration adds the columns and a check that the default tariff is never retired. The
  immutability trigger keeps refusing every change to a version's terms, and every delete.
- Audit log: `billing.tariff_version_retired` and `billing.tariff_version_restored`, with
  `service_id`, `tariff_id`, `tariff_key`, `tariff_version` and `tariff_name`.

A version cannot be retired while somebody is on it. Blockers, in this order; one function
computes them for the retire call and for the read model:

| Value | Means |
| --- | --- |
| `default` | It is the product's default tariff. |
| `assignments` | An organisation or team is assigned to it. |
| `subscriptions` | A Stripe subscription that has not ended, or a seat subscription that has not ended, names it. |
| `contract_terms` | A service term of a contract that is not terminated names it. |

History does not block: term events, settlements, reservations, ended subscriptions and
terminated contracts keep pointing at a retired version.

A retired version:

- cannot become the default (`409 BILLING_TARIFF_RETIRED`);
- cannot be assigned to an organisation or team (`409 BILLING_TARIFF_RETIRED`);
- cannot be chosen for a new contract service term, checkout or subscription;
- is skipped by every lookup that picks a tariff for new business, including the Nessie regional
  lookups by `standard-<currency>` key;
- still resolves for every past month and every existing record.

Creating a new version of a key numbers it after the highest existing version, retired or not.

### 2.2 Read model additions

`GET /internal/admin/billing/services`:

- every tariff gains `retired_at: string | null` and `retire_blocked_by: string[]` (values above;
  empty means it can be retired);
- every assignment gains `effective_from_month: string | null` (`YYYY-MM`), the
  `effective_from_month` of the newest term event whose `assignment_id` is that assignment.

Every other response that serialises a tariff or an assignment carries the same fields.

`API/src/routes/root/index.ts` and `API/src/routes/root/llm.ts` are updated in the same change.

## 3. Admin: page structure

Top tabs, in this order: **Products · Organisations · Contracts & invoices · Usage exceptions ·
SMS policies**. `section=organisations` selects the new one. Changing the top tab clears every
other billing search parameter.

The sentence "Organisations use live billing by default. Manage organisation billing" is removed
from the top of the page. The billing mode control it pointed to now also sits in the
Organisations section (§4.2).

User-visible copy says **product**, never "service": "Add product", "No products yet", "Could not
load products". The "Add product" button shows only on the product list.

Retired tariffs never appear in a control that picks a tariff.

Where a tariff is picked or listed for an organisation (the Organisations section and the "Assign
tariff" dialog), it is named by `billingTariffLabel`: its name alone, or "{name} · {key}
v{version}" when another active tariff of the same product has that name. The product Tariffs and
Assignments tables keep the name with `key vN` below it.

A refused tariff or assignment change (in the Organisations rows, and on retire, restore, set
default, assign and remove in the product view) is shown in plain words by `billingRefusal`:

| Code | Shown |
| --- | --- |
| `BILLING_TARIFF_RETIRED` | This tariff is retired. Pick another one. |
| `BILLING_TARIFF_IN_USE` | Somebody is still on this tariff. Move them first. |
| `STRIPE_TARIFF_PINNED` | An active Stripe subscription keeps the current tariff until it ends. |
| `BILLING_CONTRACT_ASSIGNMENT_LOCKED` | A contract sets this tariff. Change the contract instead. |
| `INVALID_TARIFF_ASSIGNMENT` | This tariff cannot be assigned here. |
| any other code | The change was refused ({code}). |
| no code | The change was refused (HTTP {status}). |

A routine confirmation (saving an organisation or team tariff, "Set default") uses the primary
button; removing an assignment and retiring keep the destructive one. `confirm()` takes the tone
as an optional last argument, destructive by default.

## 4. Admin: Organisations section

### 4.1 List (`?section=organisations`)

One card. Controls, in one row:

- Search field, placeholder "Search organisations", matching name and slug, in `q`.
- Product dropdown: **All products**, then every active product by name (`product=<service id>`).
- Segmented filter: **All** · **With custom tariffs** (`filter=custom`).

Table, sorted by name. With **All products**:

| Column | Content |
| --- | --- |
| Organisation | Name, a link to `?section=organisations&organisation=<id>`. Slug below in grey. |
| Teams | Number of teams. |
| Organisation tariff | One line per product where the organisation itself is assigned: "Nessie: Free" (the tariff label, §3). None: "Product defaults" in grey. |
| Team tariffs | "2 teams" when teams have their own assignment, otherwise "—". |

With one product selected, the two tariff columns describe that product only; the column keeps
the heading "Organisation tariff":

| Column | Content |
| --- | --- |
| Organisation | As above; the link also carries `product=<service id>`. |
| Teams | Number of teams. |
| Organisation tariff | The organisation's own tariff for the product, by its label (§3). Without one: "Product default — {default label}" in grey. |
| Team tariffs | One line per team with its own tariff: "Hugo: Free". None: "—". |

"With custom tariffs" keeps the organisations that hold any assignment, in the selected product
when one is selected.

- Empty result: "No organisations match."
- `PaginationFooter`, key `organisations_page`.

Data comes from the existing organisations, teams and billing services queries, joined in the
browser. No new endpoint.

### 4.2 One organisation (`?section=organisations&organisation=<id>`)

- Link back: "All organisations", keeping the list's search, product and filter.
- Card header: organisation name, slug as a code chip, and a link "Organisation details" to
  `/organisations/<id>`.
- Product tabs (`UnderlineTabs`, `product=<service id>`), active products only, sorted by name.
  Each tab's count is the number of assignments this organisation and its teams hold in that
  product. The first tab is selected when `product` is absent.
- One line under the tabs: "Product default: {name} · {key} v{version}. A team's tariff overrides
  its organisation's, which overrides the product default. A change starts on the 1st of next
  month (UTC)."
- Table:

| Column | Content |
| --- | --- |
| Applies to | First row: **Entire organisation**, below it "Every team without its own tariff". Then one row per team, sorted by name: team name linking to the team's directory page, below it "{n} members". |
| Tariff | A select with a minimum width, so its text is never cut off on a phone. Organisation row: "Product default — {default label}" then every active tariff of the product by its label (§3). Team row: "Same as organisation — {label of what the organisation resolves to}" then every active tariff. When the saved assignment has `effective_from_month` later than the current UTC month, amber text below: "Starts 1 December 2026". |
| What they pay | A plain summary of the selected tariff (§4.3). |
| Changed | Date and who, when an assignment exists; otherwise "—". Hidden below the `md` breakpoint. |
| (actions) | Empty header and a fixed width that fits Save and Cancel from the start, so nothing moves when they appear. Empty until the select differs from the saved value, then **Save** (primary, small) and **Cancel**. |

The table scrolls inside its card, as the other admin tables do.

- **Save** asks for confirmation (primary button), then calls the existing assignment endpoint.
  - Title: "Move {team or organisation} to {tariff label}?"
  - Body: "{Team} uses {tariff label} for {product} from {1 December 2026} (UTC). This month
    keeps its current terms." For the organisation row add: "Teams with their own tariff are
    not affected."
- Choosing the first option when an assignment exists removes it, after confirmation (destructive
  button).
  - Title: "Remove {team or organisation}'s own tariff?"
  - Body: "From {1 December 2026} (UTC) {team} uses {label of the fallback}."
- A refused change shows the refusal in plain words (§3) in red under the select and keeps the
  selection.
- Only one row is edited at a time; the other selects are disabled while one is unsaved or
  saving.
- `PaginationFooter` under the table, key `organisation_teams_page`. The organisation row is on
  every page, above the team rows.
- Below the card: the existing `OrganisationBillingModePanel` for this organisation, unchanged.
- Unknown organisation id: "Organisation unavailable." with the link back.

### 4.3 "What they pay" summary

One line, three parts joined by " · ":

1. Monthly: "No monthly fee" when the amount is zero; otherwise the formatted money followed by
   "per seat" or "per month".
2. Usage: "usage free" for a free tariff; "usage at cost" when the markup is zero; otherwise
   "usage +{markup}%". Then ", prepaid" or ", pay as you go" unless the tariff is free.
3. Collection: "card (Stripe)", "invoice" or "not collected".

Example: "3.99 USD per seat · usage +30%, prepaid · card (Stripe)". This is `billingTariffSummary`
in `Admin/src/features/admin/billing-format.ts`, used by the Organisations table and the product
Tariffs table. The same file holds the one date, month, label and actor formatter (§6).

## 5. Admin: product view

### 5.1 Header and tabs

- Tab order: **Tariffs · Assignments · Add-ons & credits · Subscriptions · Time periods · Cloud
  browsers · App keys · Ledger keys**. The Tariffs count is the number of active versions.
- The precedence sentence shows on Tariffs and Assignments only, with the wording from §4.2.
- One header action per tab, primary, small: "New tariff", "Assign tariff", "Add add-on or
  credit", "Issue app key". The Ledger keys panel keeps its own "Issue runtime key" button.
- Changing tab clears `record`, every `*_page` parameter and the tab-local filters `retired` and
  `key_status`.

### 5.2 Tariffs

Retired versions are hidden. When the product has any, a checkbox above the table, right-aligned:
"Show retired ({n})" (`retired=1`). Checked, the retired rows join the same table, greyed, after
the active ones.

Sorted: default first, then name, key, newest version first; retired last in the same order.

| Column | Content |
| --- | --- |
| Tariff | Name linking to the detail, `key vN` below. A blue "Default" badge beside the name, on the same line; a grey "Retired {date}" badge on a retired row ("Retired 1 Sept 2026", the table date). |
| What customers pay | The §4.3 summary, with a minimum width so it does not collapse to one word per line on a phone. |
| Used by | "{n} assignments", a link to the product's Assignments tab, when assigned; "Active subscriptions" or "Active contract" when those block; "Everyone without their own tariff" for the default; "Nobody" otherwise, and on a retired row. |
| Created | The date only (who created it is in the detail dialog). Hidden below the `md` breakpoint. |
| (actions) | Side by side on one line, right-aligned. Active row that is not the default: "Set default" and "Retire"; Retire is disabled when `retire_blocked_by` is not empty. Retired row: "Restore" only. |

Retire confirmation — title: "Retire {name} · {key} v{version}?"; body: "Nobody can be put on
this tariff any more. Its invoices, usage and history stay as they are. You can restore it
later."

Set default asks for confirmation with the primary button; Retire with the destructive one.
Restore needs no confirmation. A refusal is shown under the table in plain words (§3).

### 5.3 Assignments

| Column | Content |
| --- | --- |
| Applies to | Organisation name, and the team name or "Entire organisation" below it. |
| Tariff | Name linking to the detail, `key vN` below. |
| Starts | "1 December 2026" in amber when `effective_from_month` is in the future; "In effect" otherwise, including when it is null. |
| Changed | Date and who. |
| (actions) | "Edit" linking to `?section=organisations&organisation=<id>&product=<service id>`; "Remove" (danger) as today. A refused removal is shown under the table in plain words (§3). |

The "Assign tariff" dialog picks its organisation with the existing `AutocompleteSelect` and
offers active tariffs only, each by its label (§3). A refused save is shown in plain words.

### 5.4 App keys and Ledger keys

A segmented filter above each table: **Active (n)** · **Revoked (n)**, Active by default. Expired
app keys count as revoked for this filter. The tab count is the number of active keys. A revoked
key has no Revoke button.

### 5.5 Subscriptions

Two titled tables: "Stripe subscriptions" and "Seat subscriptions". Status badges are sentence case
("Past due").
The "Stripe mode" column is "Mode".

### 5.6 Product list

Columns: Product · Status · Default tariff · Assignments (count).

## 6. Rules for every billing table

- `usePagination` and `PaginationFooter` from `components/ui/Table`, each with its own URL key.
  This covers every table and every list that can pass ten rows, in all five sections. An
  invoice's lines are not paginated; its payment activity is (`invoice_payments_page`).
- Dates: one helper. In tables "16 Nov 2026", with the full local date and time in `title`. In
  detail dialogs the full local date and time. No raw ISO strings and no per-file `date()`.
- Missing values are "—".
- Enum values are shown as words in sentence case, never as raw identifiers.
- One empty-state row per table, grey, a full sentence.
- No file passes 500 lines. `BillingServicePanel.tsx` is split into one file per tab.

## 7. Verification

- API: service and migration tests against a real database for every blocker, retire, restore,
  the refusals a retired version causes, the audit rows and the read-model fields.
- Admin: unit tests for the summary function, the date helper and the Organisations section;
  Playwright fixtures and journeys for the list (search, product dropdown, filter), one
  organisation (save, remove, refused change), retire, show retired, restore and the key filters,
  at 1440×1000 and Pixel 7.
- Before/after screenshots of the Tariffs tab, the Assignments tab and the new section for the
  pull request.
