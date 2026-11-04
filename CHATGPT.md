# ChatGPT account connection

Faber b2.0.1 implements OpenAI's documented Sign in with ChatGPT flow for local
apps. It requests optional permission to use an eligible ChatGPT plan for model
requests. It does not read ChatGPT conversation history or reuse another app's
credentials. API-key connections remain available separately.

## Connect and choose a model

1. Open Quick start or the model selector's **OpenAI** tab.
2. Choose **Continue with ChatGPT**. Complete account selection and consent on
   OpenAI's site in your normal browser. Enable plan usage if you want inference.
3. Return to Faber and select a model from the account's returned catalog. A
   successful identity login without plan permission is shown separately.
4. Choose an available reasoning effort and prompt, then use the model in the
   selected chat. Existing chat history stays in Faber.

Model access and plan usage remain subject to OpenAI's account permissions,
availability and limits. The catalog is account-specific; Faber cannot offer
models absent from it. Context capacity and reasoning controls are shown only
when returned in model metadata. A fixed context size is informational, not an
API setting for enlarging the model's context. Usage/errors come from the service;
Faber's per-call token counts are not a remaining-subscription estimate.

Sign out in the OpenAI tab to stop that account's active runs, clear local tokens
and attempt remote revocation. If revocation fails, Faber remains locally signed
out and shows a warning. The saved connection identity and chat history remain so
reconnecting does not orphan chats. Multiple connected accounts share the same
Faber profile; they are not isolated workspaces.

## Implementation and limits

The Electron host owns OAuth, a temporary loopback callback listener, PKCE,
state/nonce validation, signed ID-token verification and refresh. A stable opaque
installation ID and each issued OAuth client ID are retained for subsequent
sign-ins. Credentials are encrypted with Electron safeStorage on Windows and
kept outside renderer state, provider records and model tools.

Inference uses the public Responses API with streaming and storage disabled.
Account tool calls use Faber's function namespace and the same approval/cancel
policy as other model providers. Full conversation input is preserved; provider
context and usage limits still apply. No private subscription endpoints, fallback
API billing or imported Codex/ChatGPT credentials are used.

Automated fixtures exercise the protocol and UI. A real account's browser consent,
entitlements and live inference must still be verified; fixture success is not
proof of service availability. The official flow currently targets open-source
and locally hosted apps; paid or remotely hosted distribution requires checking
OpenAI's separate requirements. Faber's repository license is an owner decision
and is not changed by this integration.

Primary references, checked November 3, 2026:

- [OpenAI's local-app flow](https://developers.openai.com/siwc/token-sharing-open-source)
- [Sign-in and token validation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
