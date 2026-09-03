/**
 * docs.ts — the in-product documentation. Single source of truth.
 *
 * Rendered by components/HomepageDocs.tsx, reachable from the Docs tab in the
 * homepage header and at #docs / #docs/<section id>.
 *
 * NINE sections, and the eyebrows carry their numbers, so adding or removing one
 * means renumbering the rest. There is deliberately no clone-and-run section and
 * no local-setup command anywhere in this file: the source is not published, so
 * instructions for running it yourself would document a path no reader can take.
 * `dev` blocks stay — they explain how the product works, which is different.
 *
 * WHY IT IS DATA AND NOT MARKDOWN. A typed block list renders with ~60 lines of
 * JSX and no dependency, and it type-errors if a block is malformed. A markdown
 * string would need a parser in the bundle to say the same thing.
 *
 * THE RULE FOR EDITING THIS FILE. Every claim here is checked against the source
 * before it ships — no aspirational features, no rounded-up numbers, nothing
 * that cannot be pointed at in the code. If you change behaviour, change the
 * sentence that describes it in the same commit. The security section must stay
 * in agreement with SECURITY.md and the Safe Custody card in App.tsx.
 *
 * ponytail: inline emphasis is `**bold**` split by the renderer on `**` — the
 * one markdown-ism worth supporting. If this ever needs links or italics inline,
 * that is the point to reach for a real inline parser, not before.
 */

export type DocBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'steps'; items: { title: string; text: string }[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'note'; text: string }
  | { kind: 'dev'; label?: string; blocks: DocBlock[] }

export interface DocSection {
  /** Used for the #docs/<id> deep link and the sidebar anchor. Never rename
   *  one of these without leaving the old id working — links go stale. */
  id: string
  eyebrow: string
  title: string
  blurb: string
  blocks: DocBlock[]
}

export const DOC_SECTIONS: DocSection[] = [
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'what',
    eyebrow: '01 · Start here',
    title: 'What ENZO is',
    blurb: 'One interface over nine AI providers, using keys you own.',
    blocks: [
      {
        kind: 'p',
        text: 'ENZO is a workspace for using AI models. It is not an AI company and it does not sell you tokens. You bring API keys from providers you already have accounts with, and ENZO gives you one place to use all of them — a searchable catalog of every model those providers offer, a chat terminal, and a coding mode that writes and runs whole projects.',
      },
      {
        kind: 'p',
        text: 'This is what **BYOK** means: bring your own keys. There is no ENZO account to create, no subscription, and no markup. When you send a message, the request goes from your browser through ENZO to the provider you picked, and you pay that provider their normal price. Nothing sits in between taking a cut.',
      },
      { kind: 'h', text: 'Why do it this way' },
      {
        kind: 'ul',
        items: [
          '**You already pay for models.** If you have an OpenRouter account, you have access to hundreds of models. Most tools make you pay them on top of that. ENZO does not.',
          '**No lock-in.** Your keys are yours. Delete ENZO tomorrow and nothing of yours goes with it.',
          '**Nine providers, one catalog.** OpenRouter, NVIDIA NIM, Groq, HuggingFace, Google AI Studio, Pollinations, LLM7, Puter, and Cloudflare Workers AI. Switch between them mid-conversation.',
          '**Your keys are encrypted where they live.** They are stored in your own browser as AES-256-GCM ciphertext, never on our server. See **Security and privacy** below for exactly what that protects and what it does not.',
        ],
      },
      {
        kind: 'dev',
        label: 'Under the hood',
        blocks: [
          {
            kind: 'p',
            text: 'An Express 5 backend run directly by `tsx` (no build step) and a Vite + React 18 single-page app. Chat is server-sent events end to end. The model catalog is rebuilt from every provider\'s live model list every 6 hours and cached to disk, so a provider outage does not empty the marketplace.',
          },
          {
            kind: 'p',
            text: 'The backend has two modes, decided by one environment variable. With `ENZO_MASTER_KEY` unset it is a stateless router: it holds no keys, writes no secrets, and the server-side vault writer, memory, skills and OpenAI-compatible tunnel all refuse to run. Set that variable and it becomes a single-operator install where all of that is enabled. Public deployments should leave it empty.',
          },
        ],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'start',
    eyebrow: '02 · Setup',
    title: 'Getting started',
    blurb: 'Two keys to get in. Both are free to create.',
    blocks: [
      {
        kind: 'p',
        text: 'Setup is three steps and takes a few minutes. The first two are required — without them there is no model to talk to. The third is optional but worth doing.',
      },
      {
        kind: 'steps',
        items: [
          {
            title: 'OpenRouter key — required',
            text: 'This is the big one. A single OpenRouter key gives you hundreds of models from most major labs, and OpenRouter has a free tier so you can start without adding a card. Create a key at openrouter.ai/keys, paste it in, and press Test. If you would rather not copy-paste, the Connect button runs a one-click OAuth handshake with OpenRouter instead.',
          },
          {
            title: 'NVIDIA NIM key — required',
            text: 'NVIDIA hosts a large set of open models — Llama, Qwen, DeepSeek, Nemotron — on their own fast infrastructure, free to use for development. Get a key from build.nvidia.com (click any model, then "Get API Key"). This is what makes ENZO usable when OpenRouter is rate-limiting you.',
          },
          {
            title: 'HuggingFace token — optional',
            text: 'Adds HuggingFace Inference models to your catalog. A read token from huggingface.co/settings/tokens is enough. Skip it and everything else still works; you can add it later from the Vault.',
          },
        ],
      },
      { kind: 'h', text: 'Keys you can add later' },
      {
        kind: 'p',
        text: 'Everything else is optional and lives in the Vault. Add a provider only when you want the models it carries:',
      },
      {
        kind: 'ul',
        items: [
          '**Groq** — the fastest inference available on a free tier. Tokens arrive quickly enough to change how the terminal feels. Key from console.groq.com/keys.',
          '**Google AI Studio** — the Gemini family, including long-context and vision models. Key from aistudio.google.com/apikey.',
          '**Pollinations** — image generation, and this one **needs no key at all** on its free tier. A key unlocks the higher-quality image models.',
          '**LLM7** — an aggregator with its own model set. Token from dash.llm7.io.',
          '**Puter** — a user-pays gateway with free monthly credits. Token from puter.com/dashboard.',
          '**Cloudflare Workers AI** — models running at the edge. Add an API token from your Cloudflare dashboard, or use the Connect button to authorise it.',
        ],
      },
      {
        kind: 'note',
        text: 'A key you paste is tested against the real provider before it is saved, so a typo tells you immediately instead of failing on your first message.',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'surfaces',
    eyebrow: '03 · The workspace',
    title: 'The three surfaces',
    blurb: 'Marketplace, Terminal, Vault. That is the whole app.',
    blocks: [
      {
        kind: 'p',
        text: 'Once you are in, the workspace has three tabs and nothing else to learn.',
      },
      { kind: 'h', text: 'Marketplace — find a model' },
      {
        kind: 'p',
        text: 'Every model from every provider you have connected, in one list. Search by name or description, then narrow it down: filter by task, by provider, by free or paid, by whether the model refuses less, or by "online only" to hide anything not currently responding. Sort by name, by context length, free models first, or by Recommended — which ranks on the model\'s own declared capabilities, not on anyone\'s opinion.',
      },
      {
        kind: 'p',
        text: 'Each card shows a coloured status dot from a live health probe, plus context length, price, and what the model is actually good at. Pick one and launch it straight into the Terminal.',
      },
      { kind: 'h', text: 'Terminal — talk to it' },
      {
        kind: 'p',
        text: 'Streaming chat with five modes, switchable at any time:',
      },
      {
        kind: 'ul',
        items: [
          '**Normal** — ordinary chat. Fast, no extra machinery.',
          '**Thinking** — the model reasons step by step first, and you can expand that reasoning to read it. Slower, better on hard problems.',
          '**Research** — searches the live web and synthesises the results with citations, rather than answering from training data alone.',
          '**Coding** — generates a complete multi-file project, checks it, and runs it. See **Coding mode** below.',
          '**Image Gen** — text to image.',
        ],
      },
      {
        kind: 'p',
        text: 'Three toggles are worth knowing. **Web search** lets a normal chat reach the internet when the question needs it. **Auto fallback** silently reroutes to a working model if the one you picked goes down mid-answer, so a provider outage costs you a few seconds instead of your message. **Incognito** stops the session being written to your browser at all — nothing is saved, and closing the tab is the delete button.',
      },
      {
        kind: 'p',
        text: 'The terminal also takes typed commands. `help` lists them all; `about` shows which model and mode you are actually on; `models` lists your catalog; `history` opens past sessions; `clear` wipes the screen.',
      },
      { kind: 'h', text: 'Vault — manage your keys' },
      {
        kind: 'p',
        text: 'Add, test, replace and remove provider keys. Saved keys are shown masked, never in full. The Test button makes a real call to the provider, which means you can confirm a replacement key works **before** you delete the old one — the correct order for rotating a key you think may have leaked.',
      },
      {
        kind: 'p',
        text: 'This is also where the optional passphrase for key storage is turned on.',
      },
      {
        kind: 'dev',
        label: 'Memory and skills',
        blocks: [
          {
            kind: 'p',
            text: '`/remember <fact>` stores a durable note; `/memory` lists them; `/forget` removes one or all. Memory is keyed by **topic, not by model**, which is the whole design — switch from Gemini to Llama mid-project and the context follows you. `/learn <repo-url>` clones a public repository and distils it into a reusable skill, `/skills` lists what has been learned, `/unlearn` drops one. Both features need a server-side install (`ENZO_MASTER_KEY` set); in hosted mode they are off.',
          },
          {
            kind: 'p',
            text: 'Skill learning reads **only markdown** out of a cloned repo and never executes anything from it. That boundary is deliberate and load-bearing.',
          },
        ],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'models',
    eyebrow: '04 · Choosing',
    title: 'Which model should I use?',
    blurb: 'How to read the catalog without knowing every model name.',
    blocks: [
      {
        kind: 'p',
        text: 'There are hundreds of models and most of the names mean nothing until you have used them. Some shortcuts:',
      },
      {
        kind: 'ul',
        items: [
          '**Just want a good answer, fast?** Sort by Recommended and take something near the top with a green dot.',
          '**Want it free?** Turn on the Free filter. There is a genuinely usable free tier across OpenRouter, NVIDIA, Groq and Google.',
          '**Pasting in something long** — a document, a codebase, a transcript? Sort by context length. That number is how much text the model can hold at once.',
          '**Working with images?** Filter to the Vision task. Only some models can see.',
          '**Writing code?** The Coding task filter. Models tagged Coding are also the ones that handle tool calling well.',
        ],
      },
      { kind: 'h', text: 'Ask ENZO instead' },
      {
        kind: 'p',
        text: 'You do not have to choose by hand. Describe your task in the terminal and ask for a recommendation — "which model should I use to summarise a 200-page PDF?" — and the model advisor answers from the real catalog: current prices, real context lengths, live availability. You can also ask it to compare two specific models head to head.',
      },
      { kind: 'h', text: 'Reading a model card' },
      {
        kind: 'ul',
        items: [
          '**The status dot** comes from a real request to that provider, not from a status page. Green means it answered. Red means it did not, right now — try again later, or turn on Auto fallback and stop thinking about it.',
          '**FREE** means no charge from the provider at all. Anything else shows the provider\'s own per-token price. ENZO adds nothing to it.',
          '**Context length** is in tokens. A rough rule: 1,000 tokens is about 750 words.',
          '**Tags** come from the provider\'s own model metadata, not from us.',
        ],
      },
      {
        kind: 'note',
        text: 'A red dot on a model you want is usually a rate limit, not a dead model. Free tiers throttle. Wait, or switch provider for that one message.',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'tools',
    eyebrow: '05 · Agent tools',
    title: 'Tools the model can use',
    blurb: 'Nine real tools. Ask in plain language; no syntax to learn.',
    blocks: [
      {
        kind: 'p',
        text: 'ENZO lets the model do things, not just talk. You never call a tool directly — you ask for what you want, and the model decides which tool it needs. There are nine:',
      },
      {
        kind: 'ul',
        items: [
          '**Web search** — looks something up live. Ask about anything after the model\'s training cutoff.',
          '**Deep research** — a multi-step investigation across several searches, returned as a synthesised answer rather than a link list.',
          '**Read your Gmail** — "what did Priya send me about the invoice?" Needs Google connected.',
          '**Send an email** — drafts and sends from your Gmail. Needs Google connected.',
          '**Read your calendar** — "am I free on Thursday afternoon?" Needs Google connected.',
          '**Create a calendar event** — "book a 30-minute review with Sam next Tuesday at 3." Needs Google connected.',
          '**Recommend a model** — searches the live catalog against a task you describe.',
          '**Compare models** — two or more models, side by side, on real numbers.',
          '**Document assist** — attach a file and ask for edits, a summary, or questions answered from it.',
        ],
      },
      {
        kind: 'p',
        text: 'The first two need no setup — web search works without any key, using a chain of four backends so a dead search endpoint never takes the feature down. The four Google tools need you to connect a Google account first, and Google will show you exactly which permissions it is granting.',
      },
      {
        kind: 'note',
        text: 'Tool use requires a model that supports tool calling. If a tool never fires, try one tagged Coding or Reasoning — those reliably support it.',
      },
      {
        kind: 'dev',
        label: 'Tool names and the search chain',
        blocks: [
          {
            kind: 'code',
            lines: [
              'web_search        deep_research      document_assist',
              'gmail_list        gmail_send',
              'calendar_list     calendar_create',
              'recommend_model   compare_models',
            ],
          },
          {
            kind: 'p',
            text: 'Search tries Exa (best results, needs a key), then DuckDuckGo HTML, then Bing RSS, then a model with its own browsing. Three of the four are keyless, so the feature degrades in result quality and never in availability.',
          },
          {
            kind: 'p',
            text: 'A local keyword-and-recency heuristic decides whether a question needs the web *before* a search call is spent. It is a heuristic, not a classifier — it deliberately does not fire on questions about the model itself.',
          },
          {
            kind: 'p',
            text: 'Gmail and Calendar credentials are stored server-side in a single token file, sealed with AES-256-GCM. That means **one Google identity per install** — correct for a self-hosted instance, wrong for a shared one. Recorded as known debt in `docs/PROJECT_REPORT.md` §7.',
          },
        ],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'coding',
    eyebrow: '06 · Coding mode',
    title: 'Coding mode and live preview',
    blurb: 'It writes the project, boots it, and fixes what broke.',
    blocks: [
      {
        kind: 'p',
        text: 'Coding mode does more than print code into the chat. Describe what you want built and it generates a complete project — multiple files, dependencies, config — then checks the project actually holds together, starts it, and shows you the result running in a preview pane.',
      },
      {
        kind: 'p',
        text: 'The interesting part is what happens when it fails. A model will confidently write code that imports a package it never listed, or calls a function it forgot to write. ENZO catches that before you do: it verifies the project statically, boots it for real, captures whatever the process complained about, and hands those errors back to the model to repair. You see the repair happen.',
      },
      {
        kind: 'p',
        text: 'You can read every generated file, edit it, and re-run.',
      },
      { kind: 'h', text: 'What the preview can and cannot do' },
      {
        kind: 'p',
        text: 'The preview runs generated code, so it is deliberately fenced in. The frame is sandboxed with **no access to the page around it** — code in the preview cannot read your provider keys, your session, or anything else in the main app, even though it renders inches away. Its own network requests work normally.',
      },
      {
        kind: 'note',
        text: 'If a generated project expects to reach the parent page or share its storage, it will fail in the preview. That is the sandbox working, not a bug. Download the project and run it locally.',
      },
      {
        kind: 'dev',
        label: 'The two boundaries',
        blocks: [
          {
            kind: 'p',
            text: 'The iframe carries `sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock"` and pointedly **not** `allow-same-origin`. Those two tokens together nullify a sandbox: the frame would share our origin and `window.parent.localStorage` would hand generated code every provider key and the auth token. Without it the frame gets an opaque origin, so `parent.localStorage` throws `SecurityError` while relative `fetch` still resolves.',
          },
          {
            kind: 'p',
            text: 'The backend child process is spawned with an explicit env **allowlist** — `PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`, `NODE_ENV`, `PORT`, `NODE_PATH`, `ENZO_PROJECT_ID`, `ENZO_PROJECT_DIR` — never `{...process.env}`. The child\'s stdout is streamed to the browser as a boot log, which is precisely what made inheriting the parent environment exfiltratable. Allowlist and not blocklist, so the next secret added to `.env` is not readable there by default.',
          },
        ],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'security',
    eyebrow: '07 · Security',
    title: 'Security and privacy',
    blurb: 'Where your keys live, what protects them, and what does not.',
    blocks: [
      {
        kind: 'p',
        text: 'Your provider keys are the most valuable thing in this system. Here is exactly what happens to them, including the parts that are not reassuring.',
      },
      { kind: 'h', text: 'Where your keys live' },
      {
        kind: 'p',
        text: 'In your browser. Not in a database, not in an account, not on our server. They are encrypted with **AES-256-GCM** before they are written to browser storage, so what is on disk is ciphertext rather than your key.',
      },
      {
        kind: 'p',
        text: 'The encryption key itself is generated by your browser as **non-exportable**. That is the part that matters. The browser will use it to decrypt but will not hand its bytes to any JavaScript — not to ENZO\'s code, and not to an attacker\'s. It can be used without ever being copied.',
      },
      {
        kind: 'p',
        text: 'Keys are sent with each request to reach the provider you chose, and they are not logged, stored, or synced anywhere along the way.',
      },
      { kind: 'h', text: 'Optional passphrase' },
      {
        kind: 'p',
        text: 'By default there is no prompt and nothing to remember — your keys are simply there when you come back. Turn on **passphrase mode** in the Vault and the encryption key is derived from a passphrase you choose instead, and the device key is deleted, so nothing usable remains stored at all. ENZO then asks for the passphrase once per load.',
      },
      {
        kind: 'p',
        text: 'This is off by default deliberately, because most people do not want a prompt. It is the right choice on a shared computer, or one whose disk gets backed up somewhere you do not control.',
      },
      { kind: 'h', text: 'What this does not protect against' },
      {
        kind: 'p',
        text: 'Being honest about the limits is more useful than the feature list above.',
      },
      {
        kind: 'ul',
        items: [
          '**Encryption at rest defends against offline theft** — a stolen laptop, a synced browser profile, a backup, a stray storage dump. It is not a defence against code running inside the live page. If something is executing JavaScript in your ENZO tab, it can ask the vault to decrypt, or make calls as you.',
          '**A malicious browser extension** runs with access to the page. No web app can stop that one.',
          '**The provider sees your prompts.** Whatever you send to a model goes to that company under their privacy policy. ENZO does not change that and cannot.',
          '**A weak passphrase is still weak.** The key derivation makes guessing expensive, not impossible.',
          '**A hosted server still sees traffic pass through.** It stores nothing, but it is in the path. If that matters for your work, run ENZO yourself — it is designed for exactly that and needs no external service.',
        ],
      },
      { kind: 'h', text: 'Signing in' },
      {
        kind: 'p',
        text: 'Google sign-in is optional and only exists to enable the Gmail and Calendar tools. It fails closed: if the server has not been configured with a signing secret, the sign-in routes return an error rather than issuing a token that could be forged. There is no fallback secret anywhere in the code.',
      },
      {
        kind: 'dev',
        label: 'Verify any of this yourself',
        blocks: [
          {
            kind: 'p',
            text: 'Nothing above needs to be taken on trust. In DevTools on a logged-in session, `localStorage[\'enzo.keys.openrouter\']` is `v1.gcm.<iv>.<ciphertext>`, and the `enzo-key-vault` IndexedDB entry shows a `CryptoKey` with `extractable: false`. From inside a coding-mode preview iframe, `parent.localStorage` throws.',
          },
          {
            kind: 'p',
            text: 'Implementation: `synthetic-nature/src/lib/keyVault.ts` (browser, AES-256-GCM under a non-extractable `CryptoKey`, `PBKDF2-SHA256` at 600,000 iterations in passphrase mode) and `crypto-store.ts` (server-side token files, `scrypt`-derived key, written `0o600`). Every key read in the frontend goes through `keyVault` — a CI step greps for direct storage access and fails the build on a hit, because one missed read site would ship ciphertext to a provider as if it were an API key.',
          },
          {
            kind: 'p',
            text: 'The two checks above are not the whole story: the full threat model — including the parts deliberately left unsolved, such as scripted XSS on the live page and the single shared Gmail identity in hosted mode — is written down alongside the code and kept in agreement with this section.',
          },
        ],
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'themes',
    eyebrow: '08 · Appearance',
    title: 'Themes and appearance',
    blurb: 'Ten themes, and a switch for slower machines.',
    blocks: [
      {
        kind: 'p',
        text: 'The rail in the header switches the theme instantly. There are ten: one space scene — Midnight space — and nine animated scenes, from Summer sky and Rain cottage to Moon observatory, Misty forest, Alien contact and Purple flowers. The workspace and the homepage remember your choice separately, so you can read in daylight and work in the dark.',
      },
      {
        kind: 'p',
        text: 'Light and dark are not just palette swaps here; the backgrounds are different scenes with their own motion.',
      },
      { kind: 'h', text: 'Lite mode' },
      {
        kind: 'p',
        text: 'The animated backgrounds are video. On a low-end machine, an integrated GPU, or a battery you would like to keep, **Lite mode** swaps them for a static background and drops the heavier effects. Everything works identically — it just stops spending frames on scenery. There is a toggle in the header, and ENZO turns it on by itself if it detects a device that will struggle.',
      },
      {
        kind: 'note',
        text: 'If the interface ever feels sluggish, try Lite mode before anything else. It is almost always the backgrounds.',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'faq',
    eyebrow: '09 · Help',
    title: 'Troubleshooting and FAQ',
    blurb: 'The things that actually go wrong.',
    blocks: [
      { kind: 'h', text: 'A model will not answer' },
      {
        kind: 'p',
        text: 'Check its status dot in the Marketplace. Red almost always means a rate limit on a free tier, not a broken model — free tiers throttle hard. Wait a minute, pick a different model, or turn on **Auto fallback** so ENZO reroutes for you without asking.',
      },
      { kind: 'h', text: 'It says my key is invalid but I just copied it' },
      {
        kind: 'p',
        text: 'Usually a trailing space, or a truncated paste. Re-copy the whole string and press Test — the test hits the real provider, so a pass means the key genuinely works. Also check the key is for the provider you pasted it into; an OpenRouter key in the NVIDIA field fails exactly like a bad key.',
      },
      { kind: 'h', text: 'My keys disappeared' },
      {
        kind: 'p',
        text: 'Clearing your browser data deletes them, because that is where they live — there is no server copy to restore from, by design. If you turned on passphrase mode, they are still there and simply locked; you need the passphrase. If you forgot it, the keys are unrecoverable and you should create new ones at each provider.',
      },
      { kind: 'h', text: 'Web search is not finding recent things' },
      {
        kind: 'p',
        text: 'Confirm the Web search toggle is on, or use **Research** mode, which always searches. In Normal mode a heuristic decides whether a question needs the web, and it is conservative — asking explicitly ("search for…") is the reliable way to force it.',
      },
      { kind: 'h', text: 'The Gmail or Calendar tools do nothing' },
      {
        kind: 'p',
        text: 'They need a connected Google account, and they need the model to support tool calling. If Google is connected and it still does not fire, switch to a model tagged Coding or Reasoning and ask again.',
      },
      { kind: 'h', text: 'The preview is blank' },
      {
        kind: 'p',
        text: 'Read the boot log under the preview — the generated project usually says what it failed on, and coding mode will often have already tried to repair it. If the project expects access to the surrounding page, it cannot work in the preview sandbox; download it and run it locally.',
      },
      { kind: 'h', text: 'Everything feels slow' },
      {
        kind: 'p',
        text: 'Turn on Lite mode. If it is the *responses* that are slow rather than the interface, that is the model — Groq is dramatically faster than most providers on the same model.',
      },
      { kind: 'h', text: 'Is my data used to train anything?' },
      {
        kind: 'p',
        text: 'Not by ENZO — there is no training pipeline and no store of conversations on any server. What the provider you selected does with your prompts is governed by their policy, which you should read for any provider you send real work to.',
      },
      { kind: 'h', text: 'Can I use this without any keys at all?' },
      {
        kind: 'p',
        text: 'Partly. Pollinations image generation works with no key on its free tier, and web search needs none. Chat needs at least one provider key, which is why onboarding asks for two.',
      },
      { kind: 'h', text: 'Does it cost anything?' },
      {
        kind: 'p',
        text: 'ENZO charges nothing and takes no cut. You pay each provider directly at their price, and their free tiers stay free. The Marketplace shows the real per-token price on every paid model before you use it.',
      },
    ],
  },
]
