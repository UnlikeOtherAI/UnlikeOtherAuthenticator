# Choosing an authorisation model for an org–team–member SaaS hierarchy

## Requirements implied by your hierarchy

Your structure has three stable layers—organisation → team → member—and (crucially) roles that can be assigned at *any* layer with *downward inheritance* (an org-level role implies team-level authority), while still allowing team-only roles and possibly member-specific exceptions. That combination usually forces you to answer three questions cleanly and consistently:

First, **how do you represent scope** (org-wide vs team-scoped vs individual-only) in a way that doesn't explode the number of roles or policies as customers add teams? The classical failure mode is "role explosion", where you keep minting new roles to encode combinations of scope and context. citeturn19search4

Second, **how do you compute inheritance** (org ⇒ all teams) without duplicating assignments across every team? The NIST RBAC family explicitly supports role hierarchies where senior roles acquire permissions of junior roles (and related membership semantics), which is the conceptual starting point for "inheritance", but it doesn't by itself prescribe *tenant/org/team scoping*—that part is left to your application model. citeturn9view1turn1search3

Third, **how do you keep it operable** for real admins (regional managers, venue managers) and for your own engineering team as the product grows? In practice, the most "future-proof" systems separate (a) a *small, comprehensible* set of role concepts from (b) a more expressive engine that can compute effective permissions across a resource hierarchy at scale. This is the core motivation behind Zanzibar-style systems, where ACLs are stored and evaluated using a uniform relationship data model and a configuration language expressive enough to cover many internal services. citeturn9view0

## Comparative analysis of RBAC, ABAC, ReBAC, and hybrids

This section focuses on "does it map cleanly onto org → team → member with per-layer roles and inheritance", and "does it stay manageable".

### RBAC and hierarchical RBAC

**What it is.** RBAC makes permitted actions a property of roles rather than individual identities: you assign users to roles, roles to permissions, and then evaluate access via role membership. citeturn1search1

**Inheritance and scope fit.** Hierarchical RBAC extends core RBAC with a partial order over roles (seniority), where senior roles acquire permissions of junior roles. citeturn9view1 In your domain, you typically implement *two* kinds of inheritance:

- **Role hierarchy inheritance** (e.g., `org_owner` ≥ `org_admin` ≥ `org_member`).
- **Scope inheritance** (e.g., an org-level grant applies to all teams under that organisation).

Hierarchical RBAC gives you the first formally; the second is usually implemented as a "scoped RBAC" variant (role assignments include a scope identifier). This is a very common enterprise-SaaS pattern, including Slack's own internal architecture decision to implement RBAC with roles delegated at organisation or workspace level. citeturn21search0turn21search4

**Strengths.** It is widely understood and easy to explain to administrators; it's straightforward to store in relational tables (users, roles, permissions, role_permissions, role_assignments). citeturn1search1turn1search3

**Limitations.** RBAC tends to struggle when you need fine-grained exceptions, per-resource sharing, or contextual rules (time, IP ranges, "only these teams"), and it can drift into role explosion when trying to encode nuanced conditions via new roles. citeturn19search4turn19search15

### ABAC

**What it is.** ABAC decides authorisation by evaluating attributes of the subject (user), object (resource), requested operation, and sometimes environment against policy rules. This definition is formalised in entity["organization","National Institute of Standards and Technology","us standards agency"] guidance (SP 800-162). citeturn0search3turn19search0

**Inheritance and scope fit.** ABAC can model "org-wide vs team-only" naturally as attributes (e.g., `user.org_id`, `user.team_ids`, `resource.team_id`) with policies like "allow if user.org_id == resource.org_id and user.role == 'regional_manager'". But *inheritance* becomes a policy authoring task (you write rules that reflect inheritance), and debugging can become non-trivial as policies multiply. The upside is that ABAC can reduce role explosion by replacing combinatorial roles with attribute-driven rules. citeturn19search4turn19search0

**Strengths.** Extremely flexible; can express contextual constraints cleanly (time, location/IP, resource sensitivity). citeturn0search3turn3search3

**Limitations.** Operational complexity shifts from "managing role assignments" to "managing policies plus correct attribute pipelines". NIST emphasises ABAC as an enterprise methodology; implementing it in a product-safe, tenant-admin-friendly way is often the hard part. citeturn0search3turn19search0

### ReBAC and Zanzibar-style "relationship tuple" systems

**What it is.** ReBAC models authorisation from relationships between users and resources, typically represented as edges in a graph. Research and survey literature characterises ReBAC policies as expressing protection requirements in terms of relationships among users and resources modelled as a graph, often captured as paths/constraints. citeturn14view0turn2search0

**Why it maps unusually cleanly to your hierarchy.** Your domain is *already* a relationship graph:

- Team "belongs to" organisation.
- Member "belongs to" team.
- A role assignment is also a relationship: "user U is admin of team T".

Zanzibar-style systems treat ACLs as a large set of relationship facts with a configuration language to compute permissions from those facts. The Zanzibar paper describes a uniform data model and configuration language used across many services at entity["company","Google","tech company"], scaling to trillions of ACLs with low-latency checks, and supporting relations plus set-algebraic operators such as union and intersection to define permissions in terms of relations. citeturn9view0

**Inheritance and scope fit.** In Zanzibar-like models, "org admin implies team admin" is a first-class pattern: define a `parent` relation and compute team permissions from org permissions "from parent". This is the same modelling pattern documented in modern Zanzibar-inspired engines (for example, modelling parent-child relationships between objects). citeturn20search3turn20search19

**Strengths.** Very strong fit for multi-level membership, cross-cutting roles, and future expansion to new resource types. It also avoids duplicating org-wide roles onto each team by computing effective access through the hierarchy. citeturn9view0turn20search7

**Limitations.** Expressiveness can increase cognitive load. Academic work notes that ReBAC policies can be very expressive, and that expressiveness can complicate understanding and analysis of what authorisations exist as the system evolves. citeturn14view0 In practice, teams mitigate this with good tooling, strict schema review, and limiting which relations tenants can manage.

### Hybrid models

Most real enterprise systems end up hybrid in one of two ways:

- **RBAC + resource ACLs/sharing:** coarse admin roles, plus per-resource share permissions.
- **ReBAC core + ABAC constraints:** relationships define "who is in what", and conditions narrow decisions (time/IP/region/etc.).

This hybrid is explicitly supported by modern "policy language + entity graph" systems: Cedar design patterns describe "membership permissions" (group/role membership) and then using attribute conditions to prevent role explosion when roles must apply only to particular sets of resources. citeturn19search1turn4search1

Likewise, Zanzibar-inspired engines have added conditionality: OpenFGA documents "conditional relationship tuples" for contextual evaluation, and SpiceDB documents "caveats" for conditional access based on provided context. citeturn8search5turn8search20

## What enterprise SaaS products do for similar org → team → member structures

This is less about "which acronym" they pick, and more about the operational pattern they implement: scoped roles at multiple levels, plus fine-grained permissions where needed.

### Slack

Slack explicitly adopted **RBAC** internally for its role management architecture: users can be granted one or more roles that carry permissions, and those roles need to be delegable at organisation level (Enterprise Grid) or workspace level. citeturn21search0turn21search4 That is effectively "roles with scope", matching your org/team split.

Slack's admin documentation also distinguishes org-level roles (org owners/admins) from workspace roles and system roles, reinforcing the idea of multiple layers of role scope. citeturn6search0turn21search8

### GitHub

GitHub uses **organisation-level roles** (owner, member, billing manager, moderator, security manager, etc.) and uses teams to manage access. citeturn6search13turn21search5 Notably, GitHub's "security manager" is an org-level role that can be assigned to a member *or a team*, which is a concrete example of assigning elevated capability across a subset of people via a team construct. citeturn6search1

GitHub further applies roles at additional scopes (e.g., repository roles) and supports managing repository access via teams and per-repository role assignments. citeturn18search5turn21search1 This is the classic "RBAC + resource-scoped roles/ACL" hybrid.

### Notion

Notion distinguishes **workspace roles** (workspace owner, membership admin, member, guest) and separately defines **teamspace roles** (teamspace owners and teamspace members), indicating multi-layer role scope similar to your org/team model. citeturn21search3turn18search6 Notion then adds fine-grained, per-page permission levels (e.g., full access vs view) when sharing content. citeturn6search14turn21search19

This is a strong example of: *coarse roles at the top layers + resource-specific permissions lower down*.

### Linear

Linear's docs describe multiple **workspace-level roles** and explicitly mention SCIM-based provisioning on Enterprise plans, implying a separation between identity provisioning (SCIM) and in-app roles. citeturn22search0turn5search1 Linear also supports team-scoped control via features such as private teams and team owners, and guests who only have access to the teams they've joined. citeturn22search3turn22search22

The pattern matches your hierarchy: workspace (org) + teams + members, with role scope at workspace and team layers.

### Google Workspace

Google Workspace is explicitly role-based for admin access: you can assign administrator roles (prebuilt or custom), and Google's Admin/Directory API documentation states that it provides role-based access control for managing access to features in a domain, including custom roles and privilege bundles. citeturn7search2turn21search2turn21search6

Google Workspace also uses organisational units (OUs) as a hierarchical structure where child OUs inherit settings from parents, and it supports creating an admin role scoped to an organisational unit (delegated administration), which is directly analogous to "org-level vs sub-org/team scope". citeturn18search17turn7search0

## Standards, protocols, and building blocks commonly used in implementations

A useful way to think about the ecosystem is: standards often solve **identity lifecycle and tokenisation**, whereas fine-grained authorisation engines solve **permission computation**.

### SCIM and OAuth scopes as "plumbing", not your permission engine

SCIM is an IETF standard suite for identity management with a core schema and an HTTP-based protocol designed to make managing identities in multi-domain scenarios easier (enterprise-to-cloud, inter-cloud). citeturn5search0turn5search1 In practice, SCIM is most relevant to your system for:

- provisioning users and groups/teams into your application,
- keeping membership in sync with an enterprise IdP.

OAuth 2.0 is an authorisation framework for delegated access to HTTP services, and "scope" is the mechanism that limits what an issued access token may be used for. citeturn5search2turn5search5 For your SaaS, OAuth scopes are typically best used to protect API endpoints and third-party integrations, while *in-app* permissions are derived from your chosen ACL model.

Both SCIM and OAuth complement (rather than replace) your internal authorisation model.

### Zanzibar-inspired systems and their open-source descendants

Zanzibar is significant because it documents a high-scale, consistent, company-wide authorisation system with a uniform model and a configuration language used across many services. citeturn9view0 This design has strongly influenced modern fine-grained authorisation systems.

OpenFGA is explicitly inspired by Zanzibar and uses relationship-based access control to implement RBAC and also support ABAC-like capabilities; it is a entity["organization","Cloud Native Computing Foundation","linux foundation project"] project (accepted and later advanced in maturity levels), which is a strong "industry standardisation" signal for cloud-native adoption. citeturn0search6turn17search0 OpenFGA supports PostgreSQL storage and documents production concerns such as read replicas. citeturn15search21turn15search5

SpiceDB is described as an open-source, Zanzibar-inspired database system for real-time, security-critical application permissions, and it supports relational datastores including PostgreSQL. citeturn23search16turn15search4turn15search0

Both ecosystems support "relationship + condition" hybrids: OpenFGA documents conditional tuples and SpiceDB documents caveats. citeturn8search5turn8search20

### OPA and Cedar as policy engines

OPA is a general-purpose policy engine; it is a CNCF graduated project, a maturity indicator that it has broad adoption and governance stability. citeturn16search0turn16search1 OPA policies are written in Rego and can implement RBAC-style decisions (OPA documentation includes RBAC examples and comparisons). citeturn3search0turn3search9 In multi-tenant contexts, AWS prescriptive guidance includes examples using OPA and Rego for tenant-aware RBAC patterns in SaaS APIs. citeturn3search6

Cedar is a policy language and evaluation engine designed for authorisation, with explicit support for common models such as RBAC and ABAC, with documented design patterns for membership permissions and mixing patterns. citeturn4search2turn19search1 It is also used by AWS Verified Permissions (a managed policy store/evaluator), whose docs describe policies as statements permitting or forbidding principals taking actions on resources, and whose terminology explicitly positions Cedar as combining RBAC and ABAC approaches. citeturn3search1turn3search5

A practical distinction:

- OPA/Cedar excel when your "policy" is primarily **rule evaluation over structured input** you can provide at request time.
- Zanzibar-style systems excel when your "policy" is primarily about **graph relationships and inheritance across resources**, which is exactly what org/team/member is.

## Trade-offs between flexibility and operational complexity

### Flexibility

- **ABAC** is the most flexible in principle (any attribute combination), and formal guidance defines it as evaluating attributes of subject/object/operation/environment. citeturn0search3turn19search0  
- **ReBAC/Zanzibar-style** is extremely flexible for hierarchical and sharing-style permissions because relationships and parent-child resource graphs are first-class, and permissions can be computed via set operations over relations. citeturn9view0turn14view0  
- **RBAC** is flexible mainly via role design and scoping, but can strain under exceptions or contextual needs, creating role explosion. citeturn19search4turn19search15  

### Administrability

- **RBAC (scoped)** tends to be easiest for tenant admins to understand ("Alice is regional_manager for org X"; "Bob is bartender for pub Y"), and this is reflected in mainstream SaaS patterns like Slack's org/workspace roles and GitHub's org/team/repo roles. citeturn21search0turn21search5turn21search9  
- **ABAC/policy-as-code** can be hard for tenant admins unless you build robust UI, testing, and policy explanation, because "why was access granted?" depends on policy logic and attribute correctness. The complexity is widely recognised in practice, and the role explosion problem is often cited as one reason people consider ABAC—meaning you're trading one kind of complexity for another. citeturn19search4turn19search0  
- **ReBAC/Zanzibar-style** sits in the middle: relationships are intuitive ("member of team", "team belongs to org"), but the computed-permission layer needs discipline. Research highlights that expressive ReBAC policies can become difficult to comprehend as graphs and rules evolve. citeturn14view0  

### Operational and system complexity

If you **introduce a separate authorisation datastore/service** (e.g., a Zanzibar-inspired engine alongside your app database), you must manage *consistency of writes* between your application state and authorisation state. SpiceDB documentation discusses strategies for writing relationships alongside relational-db transactions (a "two writes & commit"-style approach), and the broader "dual-write" problem is a known failure mode when updates can land in one system but not the other. citeturn20search6turn20search14

The flip side is that these systems are designed for high-volume, low-latency permission checks, and Zanzibar itself was built to provide consistent authorisation decisions under concurrent ACL changes at very large scale. citeturn9view0

## Recommendation for your case and a PostgreSQL-friendly mapping

### The model to choose

For your stated goals—role assignment at any layer, downward inheritance, multi-tenant SaaS growth without redesign, and clean mapping to a relational store—the strongest fit is:

**A Zanzibar-style relationship-based authorisation model (ReBAC) with "roles as relations", optionally augmented with conditional rules (ABAC-like) where needed.**

The reasons are structural:

- Your hierarchy is naturally a **resource graph**, and Zanzibar-style systems are literally designed to compute permissions over graphs of relationships and inheritance. citeturn14view0turn9view0  
- This model can implement "classic RBAC" as a special case (roles are relations on objects like org/team), while retaining a path to fine-grained, per-resource permissions later (documents, schedules, inventory, etc.) without redesign. citeturn0search6turn20search7  
- It is **widely adopted at the high end** (Zanzibar at Google across many services) and has **industry-standard open implementations** (OpenFGA in CNCF incubation; SpiceDB as a Zanzibar-inspired permissions database). citeturn9view0turn17search0turn23search16turn15search4  
- It is straightforward to store in a relational model because the core data structure is a **tuple/edge table** (object–relation–subject), and both OpenFGA and SpiceDB support PostgreSQL as a backing store. citeturn15search21turn15search5turn15search0turn15search7  

### A concrete mapping onto org → team → member with inheritance

A practical Zanzibar-style schema usually has three ingredients:

- **Objects** (organisation, team, and later any resource types).
- **Relations** (membership and roles).
- **Computed permissions** that reference parent relations.

Conceptually, you model:

- `team has parent organisation`
- `user is member of team`
- `user has role on organisation` (e.g., `org_admin`)
- define `team_admin` to include `org_admin from parent` (inheritance)

This is the same "object-to-object relationship plus derived permission" modelling pattern documented for Zanzibar-inspired systems. citeturn20search3turn20search7

If you later need contextual constraints (e.g., "regional_manager valid only during shift hours" or "certain actions only from venue IP ranges"), you can introduce conditions/caveats on the relevant relationships rather than minting new roles—mirroring OpenFGA's conditional tuples or SpiceDB's caveats. citeturn8search5turn8search20

### PostgreSQL storage shape that stays simple

If you implement this via an existing engine, the "shape" you store is still important because it needs to integrate with your product data model.

A minimal relational representation is essentially a **relationship tuple table**:

- tenant/organisation identifier (for isolation),
- object type + object id,
- relation name,
- subject type + subject id (and optionally subject relation, for "userset"/group references),
- optional condition data (JSON).

This maps closely to how Zanzibar-inspired systems operate (uniform relationship facts plus computation language) and fits PostgreSQL well; OpenFGA explicitly supports PostgreSQL as a storage backend and SpiceDB provides a PostgreSQL datastore implementation. citeturn15search21turn15search5turn15search7turn15search0

### Implementation choice: build vs adopt

Given your "industry-standard, won't need redesign" requirement, adopting an implementation is usually the safer bet than reimplementing the evaluation semantics yourself:

- **OpenFGA** gives you a Zanzibar-inspired modelling language and APIs, is in CNCF incubation, and supports PostgreSQL storage. citeturn17search0turn15search21turn15search5  
- **SpiceDB** is positioned as an open-source Zanzibar-inspired permissions database with PostgreSQL support, and documents operational details like datastore options and relationship write patterns. citeturn23search16turn15search0turn20search6  

Both are designed to "start simple and evolve", which aligns with your stated objective of not redesigning as the system grows. citeturn15search1turn23search16

The main architectural trade-off to plan for is **data consistency** between your app database and your permissions store; the dual-write problem is real, and vendor docs discuss common approaches and failure modes. citeturn20search6turn20search14

### Where RBAC and policy engines still fit

Even if you choose Zanzibar-style ReBAC as the core model, you will still typically use:

- **SCIM** for user/team provisioning and lifecycle management, especially for enterprise clients. citeturn5search1turn5search0  
- **OAuth scopes** to constrain API tokens and third-party integrations, rather than as your internal permission model. citeturn5search2turn5search5  
- **OPA or Cedar** selectively for "policy rules" that are not primarily relationship-graph problems (e.g., compliance gates, environment-based controls), particularly if you want policy-as-code workflows and analysis tooling. citeturn16search0turn3search9turn4search2turn3search5  

This maps to what you see in mature SaaS products: scoped roles at multiple layers (Slack, GitHub, Notion, Linear, Google Workspace) plus additional fine-grained controls when resource-level sharing or constraints are needed. citeturn21search0turn21search5turn21search3turn22search0turn7search0
