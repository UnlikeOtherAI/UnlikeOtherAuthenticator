# Billing admin: organisation tariffs, unused-tariff deletion, tab cleanup

Status: contract for the 16 November 2026 work. Where this document and the code disagree while
building, report the deviation; do not silently pick one.

## 1. What changes

1. **Organisations** is a new section of Admin → Billing. An operator picks an organisation and
   edits the tariff of the organisation and of each of its teams, per product.
2. A tariff version that nothing refers to can be **deleted**. A version anything refers to stays
   immutable, as before.
3. The product view is reorganised: fewer, clearer columns, one date format, one action style,
   and the standard pagination footer under every table.

Nothing here changes how tariffs are resolved or when a change starts. An assignment still starts
on the first day of the next UTC month.

## 2. API

### 2.1 Delete an unused tariff version

`DELETE /internal/admin/billing/services/:serviceId/tariffs/:tariffId` — admin superuser, `204`.

- `404 BILLING_TARIFF_NOT_FOUND` when the tariff is not in that service.
- `409 BILLING_TARIFF_IN_USE` when any blocker below applies.
- Runs in one serializable transaction that takes `lockTariffHistoryService` first.
- Removes the tariff's Stripe price mappings that never reached Stripe
  (`stripe_monthly_price_id IS NULL`) and then the tariff row.
- Writes `billing.tariff_version_deleted` to the admin audit log with `service_id`, `tariff_id`,
  `tariff_key`, `tariff_version`, `tariff_name` and `removed_price_mappings`.

Blockers, in this order. The same function computes them for the delete and for the read model:

| Value | Means |
| --- | --- |
| `default` | It is the product's default tariff. |
| `assignments` | An organisation or team is assigned to it. |
| `tariff_history` | A tariff term event names it: it was a default or an assignment at some time. |
| `stripe_prices` | A price mapping with a real Stripe price id exists. |
| `checkouts` | A Stripe checkout session names it. |
| `subscriptions` | A Stripe subscription names it. |
| `seat_subscriptions` | A seat subscription names it. |
| `contract_terms` | A contract service term names it. |
| `usage` | Any usage or funding record names it: credit usage settlements, prepaid reservations, paid-usage liabilities, and every other table with a `tariff_id` column. |

The implementer enumerates **every** column that stores a tariff id in `API/prisma/schema.prisma`,
including the ones with no foreign key, and maps each to one of the values above. A test fails
when a new `tariff_id` column is added without a mapping.

The database trigger `uoa_enforce_billing_tariff_immutability` refuses every delete today. A new
migration replaces the function so a delete is refused only for the default tariff; the existing
`ON DELETE RESTRICT` foreign keys keep refusing a referenced one. Updates stay exactly as
restricted as they are.

### 2.2 Read model additions

`GET /internal/admin/billing/services`:

- every tariff gains `delete_blocked_by: string[]` (values above; empty means deletable);
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

## 4. Admin: Organisations section

### 4.1 List (`?section=organisations`)

One card.

- Search field, placeholder "Search organisations", matching name and slug, in `q`.
- Segmented filter: **All** · **With custom tariffs** (`filter=custom`).
- Table, sorted by name:

| Column | Content |
| --- | --- |
| Organisation | Name, a link to `?section=organisations&organisation=<id>`. Slug below in grey. |
| Teams | Number of teams. |
| Organisation tariff | One line per product where the organisation itself is assigned: "Nessie: Free". None: "Product defaults" in grey. |
| Team tariffs | "2 teams" when teams have their own assignment, otherwise "—". |

- Empty search: "No organisations match this search."
- `PaginationFooter`, key `organisations_page`.

Data comes from the existing organisations, teams and billing services queries, joined in the
browser. No new endpoint.

### 4.2 One organisation (`?section=organisations&organisation=<id>`)

- Link back: "All organisations".
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
| Tariff | A select. Organisation row: "Product default — {default name}" then every tariff of the product as "{name} · {key} v{version}". Team row: "Same as organisation — {name of what the organisation resolves to}" then every tariff. When the saved assignment has `effective_from_month` later than the current UTC month, amber text below: "Starts 1 December 2026". |
| What they pay | A plain summary of the selected tariff (§4.3). |
| Changed | Date and who, when an assignment exists; otherwise "—". |
| (actions) | Empty until the select differs from the saved value, then **Save** (primary, small) and **Cancel**. |

- **Save** asks for confirmation, then calls the existing assignment endpoint.
  - Title: "Move {team or organisation} to {tariff name}?"
  - Body: "{Team} uses {tariff name} for {product} from {1 December 2026} (UTC). This month
    keeps its current terms." For the organisation row add: "Teams with their own tariff are
    not affected."
- Choosing the first option when an assignment exists removes it, after confirmation.
  - Title: "Remove {team or organisation}'s own tariff?"
  - Body: "From {1 December 2026} (UTC) {team} uses {name of the fallback}."
- A refused change shows the server's message in red under the select and keeps the selection.
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
  browsers · App keys · Ledger keys**.
- The precedence sentence shows on Tariffs and Assignments only, with the wording from §4.2.
- One header action per tab, primary, small: "New tariff", "Assign tariff", "Add add-on or
  credit", "Issue app key". The Ledger keys panel keeps its own "Issue runtime key" button.
- Changing tab clears `record` and every `*_page` parameter.

### 5.2 Tariffs

Sorted: default first, then name, key, newest version first.

| Column | Content |
| --- | --- |
| Tariff | Name linking to the detail, `key vN` below. A blue "Default" badge beside the name. |
| What customers pay | The §4.3 summary. |
| Used by | "{n} assignments" when assigned; "Billing history" when blocked by anything else; "Not used" otherwise. |
| Created | Date; below it who, with `system:*` shown as "System". |
| (actions) | "Set default" when it is not the default. "Delete" (danger) when `delete_blocked_by` is empty. |

Delete confirmation — title: "Delete {name} · {key} v{version}?"; body: "Nothing refers to this
tariff version. Deleting it cannot be undone."

### 5.3 Assignments

| Column | Content |
| --- | --- |
| Applies to | Organisation name, and the team name or "Entire organisation" below it. |
| Tariff | Name linking to the detail, `key vN` below. |
| Starts | "1 December 2026" in amber when `effective_from_month` is in the future; "In effect" otherwise; "—" when null. |
| Changed | Date and who. |
| (actions) | "Edit" linking to `?section=organisations&organisation=<id>&product=<service id>`; "Remove" (danger) as today. |

The "Assign tariff" dialog picks its organisation with the existing `AutocompleteSelect`.

### 5.4 App keys and Ledger keys

A segmented filter above each table: **Active (n)** · **Revoked (n)**, Active by default. Expired
app keys count as revoked for this filter. The tab count is the number of active keys.

### 5.5 Subscriptions

Two titled tables: "Stripe subscriptions" and "Seat subscriptions". Status badges are title case.
The "Stripe mode" column is "Mode".

### 5.6 Product list

Columns: Product · Status · Default tariff · Assignments (count).

## 6. Rules for every billing table

- `usePagination` and `PaginationFooter` from `components/ui/Table`, each with its own URL key.
  This covers every table and every list that can pass ten rows, in all five sections.
- Dates: one helper. In tables "16 Nov 2026", with the full local date and time in `title`. In
  detail dialogs the full local date and time. No raw ISO strings and no per-file `date()`.
- Missing values are "—".
- Enum values are shown as words in sentence case, never as raw identifiers.
- One empty-state row per table, grey, a full sentence.
- No file passes 500 lines. `BillingServicePanel.tsx` is split into one file per tab.

## 7. Verification

- API: service and migration tests against a real database for every blocker, the delete, the
  audit row and the two read-model fields.
- Admin: unit tests for the summary function, the date helper and the Organisations section;
  Playwright fixtures and journeys for the list, one organisation (save, remove, refused change),
  tariff delete and the key filters, at 1440×1000 and Pixel 7.
- Before/after screenshots of the Tariffs tab, the Assignments tab and the new section for the
  pull request.
