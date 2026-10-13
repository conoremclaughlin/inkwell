# Licensing

Inkwell separates the source-available server from the MIT-licensed runtime and
clients. This page explains that boundary; the applicable license text controls.

## Scope

| Component                                                             | License                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Inkwell server, `packages/api`, and its modifications and derivatives | [Inkwell Server License 1.0](../packages/api/LICENSE), an extension of FSL 1.1 with additional provisions |
| Runtime, providers, and node-host exports in `packages/shared`        | [MIT immediately](../packages/shared/LICENSE)                                                             |
| CLI, `packages/cli`                                                   | [MIT immediately](../packages/cli/LICENSE)                                                                |
| Benchmark harness source, `packages/benchmarks`                       | [MIT](../packages/benchmarks/LICENSE); the API it imports retains the server license                      |
| Other first-party files outside the server, including `supabase/`     | [Root MIT license](../LICENSE), unless separately marked                                                  |
| Third-party dependencies and files with their own notices             | Their respective licenses, not replaced by this table                                                     |

Copying server code into an MIT directory does not relicense it. Conversely,
importing or connecting to the server does not replace the license of independently
written client code. Running, modifying, or distributing the server still requires
the applicable server permissions. A distribution containing multiple components
must preserve their respective notices and permissions.

The package-local MIT notices make the runtime and CLI grants explicit; they do
not certify every dependency or published package. The benchmark harness's license
does not provide an MIT grant for its API dependency.

## What the server extension adds

The license retains FSL 1.1's competing-use rule and adds **Restricted Commercial
Use** to the purposes excluded from the grant. This is one integrated, modified
license, not standard FSL offered alongside an optional restriction. Package
metadata points to the full text rather than identifying it as unmodified
`FSL-1.1-MIT`. `LicenseRef-Inkwell-Server-1.0` is a custom reference, not a claim
that this is a standard SPDX-listed license.

Separate written authorization is required to provide commercial server hosting,
managed operation, or access, or to operate the server to supply its functionality
to outside users of a commercial application or service. The application need not
compete with Inkwell. A UI, API proxy, different brand, or use of the server only
as a backend does not remove that condition. Paid bundles, advertising-supported
offerings, and free tiers of a monetized offering are included.

Standard FSL already restricts competing hosted products and substantially similar
commercial applications. The extension additionally covers server-backed
commercial offerings that are not competing products. This is a substantive
restriction, not merely an explanation of standard FSL.

### Examples during a version's restrictive period

These examples assume no separate commercial authorization or applicable older
grant. Other license obligations, including the competing-use rule, still apply.

| Activity                                                                                                            | Result under the server license                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal self-hosting                                                                                               | Permitted.                                                                                                                                                                                                      |
| A company's internal assistant used by employees and contractors acting on its behalf                               | Permitted if it does not supply server-backed functionality to outside users.                                                                                                                                   |
| Selling a managed Inkwell instance or hosted API                                                                    | Separate written authorization required.                                                                                                                                                                        |
| Selling an app that uses the seller's server to provide features through a proxy                                    | Separate written authorization required, even if the app does not compete with Inkwell.                                                                                                                         |
| An ad-supported app or free tier of a paid service using that server backend                                        | Separate written authorization required.                                                                                                                                                                        |
| Selling an app built only with the MIT runtime, without the protected server                                        | Governed by MIT; no server-license permission required.                                                                                                                                                         |
| Paid installation, customization, or support for an otherwise permitted customer deployment                         | Permitted; not an exception for selling ongoing managed operation or hosting.                                                                                                                                   |
| Renting a general-purpose VM, disk space, or bandwidth on which a customer installs and runs a permitted deployment | Not restricted merely for supplying those resources.                                                                                                                                                            |
| Selling documents or reports created using an internal deployment                                                   | Permitted when selling the work product, not server-backed application or service access. A service fulfilling users' requests with server functionality is not exempt merely because its output is a document. |

**General-purpose infrastructure is not a managed-hosting exception.** Supplying
resources on which a customer operates their own deployment is different from
selling a managed Inkwell instance or an Inkwell-backed application. Running that
service on an ordinary VM does not change the distinction.

**Independent paid clients need separate analysis.** An independently authored
client connecting to a customer's lawful server does not, merely by speaking its
API, become subject to this server license. Assess what rights each party
exercises and how the server is operated. Do not assume this extension binds a
client seller who neither uses nor distributes the server, or that the client's
license authorizes the customer's server use.

## Two years, per version

The server's **Grant of Future License is unchanged**. On the second anniversary
of when a server version was made available, a recipient can choose MIT for that
version. The extension's commercial restrictions do not survive as conditions of
that MIT grant: commercial hosting and paid applications are then permitted under
MIT's terms. A later release has its own date and does not reset an earlier
version's clock. Installation, subscription, or purchase dates do not set it.

This is the per-version mechanism described by [FSL](https://fsl.software/).
Runtime and client MIT grants apply immediately, without this wait. Earlier
license grants are not revoked by the extension; evaluate the license supplied
with the relevant version rather than assuming today's terms apply retroactively.

## Commercial authorization

Uses outside the grant require separate written authorization from the Licensor
identified in the server license. Neither this explanatory page nor an assumption
that an offering is small, free-tier, or non-competing supplies that authorization.
