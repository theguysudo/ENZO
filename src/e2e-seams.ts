/**
 * e2e-seams.ts — scripted LLM fixtures for hermetic full-stack e2e testing.
 *
 * index.ts spreads e2eSeams() into createAgentRouter when ENZO_E2E_SEAMS=1.
 * The real server then boots with the real routes, real vault auth, real rate
 * limits, real scheduler/trainer — every code path except the outbound
 * provider HTTP hop, which these seams replace with deterministic scripts.
 *
 * The fixtures mirror the repo's own tests/agents.test.ts seam shapes (chunk
 * = {choices:[{delta}]}), but live OUTSIDE the test files so the REAL
 * index.ts can import them — the browser test and tests/e2e-fullstack.ts
 * drive the same instance.
 *
 * Prompt-keyed dispatch (same idea as the agents.test.ts seam): pass 1
 * (domain analyst) gets a JSON analysis, pass 2 (veteran manual) gets a
 * real manual with every mandated section, the handoff classifier gets its
 * yes/no JSON. ENZO_E2E_BROKEN=1 makes the drafting seam throw, exercising
 * the honest-template path.
 *
 * SECURITY: env-gated (returns {} unless explicitly enabled), never set in
 * any deployment channel (.env isn't one, and docker-compose doesn't pass
 * it), and contains no secrets — only scripts.
 */

const E2E_BROKEN = process.env.ENZO_E2E_BROKEN === '1';

const chunk = (delta: any): any => ({ choices: [{ delta }] });

/** Deterministic, task-keyed domain analysis (pass 1). */
const domainFor = (user: string) => {
  if (/mun|model un|position paper/i.test(user)) {
    return {
      domain: 'MUN procedural rules and country-position research',
      subfield: 'country-position research and position-paper drafting',
      deliverable: 'a one-page position paper for a delegate',
      audience: 'the delegate speaking in committee',
      expertProfile: 'knows which country positions are locked and which drift by committee',
      domainTerms: ['position paper', 'moderated caucus', 'bloc'],
    };
  }
  return {
    domain: 'accounts payable operations (invoice triage)',
    subfield: 'urgent-vs-routine triage',
    deliverable: 'a short triage note per urgent invoice',
    audience: 'the operator paying the bills',
    expertProfile: 'knows which vendors lie about due dates',
    domainTerms: ['net-30', 'dunning', 'PO match'],
  };
};

/** Pass 2: a real-shaped veteran manual with every mandated section. */
const manualFor = (domain: string) => JSON.stringify({
  name: /mun|model un/i.test(domain) ? 'MUN Position Researcher' : 'Invoice Watcher',
  tools: /mun|model un/i.test(domain) ? ['web_search'] : ['gmail_list', 'web_search'],
  domain,
  systemPrompt: [
    `IDENTITY: I am a 30-year veteran of ${domain}.`,
    'TACIT KNOWLEDGE: The official documentation never says it, but every practitioner learns it the hard way — the real deadlines hide in the exceptions, not the rules. Trust the pattern of what actually happens over what the handbook claims.',
    'OPERATING PROCEDURE: 1) Establish the full context before touching anything. 2) Verify against the primary source, never a summary. 3) Draft, then sleep on the decision points, then finalize. 4) Report what was done, what was skipped, and why.',
    'DECISION HEURISTICS: When two sources conflict, prefer the one with the more recent primary evidence. When in doubt, flag it explicitly rather than guessing silently.',
    'OUTPUT FORMAT: A tight summary first, then the detail, then the open questions that need a human call.',
    'EDGE CASES: Empty input, ambiguous requests, and contradictory instructions all get the same treatment — ask once, document the answer, never guess twice.',
  ].join('\n\n'),
});

/** The seam deps index.ts spreads into createAgentRouter. */
const seams: Record<string, unknown> = {
  // Two-pass drafting + handoff classify, prompt-keyed.
  _draftChat: (async (sys: string, user: string): Promise<string> => {
    if (E2E_BROKEN) throw new Error('HTTP 429: rate limited (e2e broken mode)');
    if (sys.includes('classify user messages')) {
      const create = /create|make|build|design/i.test(user) && /agent/i.test(user);
      const task = create
        ? String(user)
            .replace(/^Message:\s*/i, '')
            .replace(/^(?:please\s+)?(?:create|make|build|design)\s+(?:me\s+)?(?:an?\s+)?agent\s+(?:that|to)\s*/i, '')
            .trim()
            .slice(0, 300)
        : '';
      return JSON.stringify({ create, task });
    }
    if (sys.includes('domain analyst')) {
      return JSON.stringify(domainFor(user));
    }
    // Pass 2 — the system prompt embeds the pass-1 domain; key off it.
    const m = /domain[:\s]+([^.\n]+)/i.exec(sys) || [];
    const domain = (m[1] || '').trim() || domainFor(user).domain;
    return manualFor(domain);
  }) as any,

  // Gather: fake search results + distilled notes, zero network.
  _gather: (async (task: string, opts: any) => {
    const { gatherDomainKnowledge } = await import('./agents/gather.js');
    return gatherDomainKnowledge(task, {
      ...opts,
      _search: async () => [
        { title: 'Domain handbook', url: 'https://example.com/handbook', site: 'example.com', desc: 'Reference procedures.' },
      ],
      _cloneAndDistill: async () => null,
      _fetchUrl: async () => 'Reference page text: procedures, conventions, and edge cases for the domain.',
      _distillNotes: async () => ['The reference handbook is updated quarterly; older copies misstate the current rules.'],
    });
  }) as any,

  // Run loop stream: first turn calls a tool; after the tool result, answer.
  _createStream: (async (opts: any) => {
    async function* stream() {
      const last = opts.messages[opts.messages.length - 1];
      if (last?.role === 'tool') {
        yield chunk({ content: 'Handled like the veteran the manual describes: context verified against the primary source, the two urgent items flagged, and the open question raised for a human call.' });
      } else {
        yield chunk({
          tool_calls: [{
            index: 0,
            id: 'call_e2e_lookup',
            type: 'function',
            function: { name: 'web_search', arguments: JSON.stringify({ query: 'verify the current domain rules' }) },
          }],
        });
      }
    }
    return stream();
  }) as any,

  // Neural deep-tune: proposes one lesson + a focus term.
  _trainChat: (async () => JSON.stringify({
    lessons: ['Always verify against the primary source before flagging anything urgent.'],
    focus: ['primary source'],
  })) as any,
};

/**
 * The deps index.ts spreads into createAgentRouter. Empty unless
 * ENZO_E2E_SEAMS=1 — production boots get the plain {} and the router runs
 * fully live. (Static import + env guard instead of a dynamic top-level
 * await, which CJS output can't host.)
 */
export function e2eSeams(): Record<string, unknown> {
  if (process.env.ENZO_E2E_SEAMS !== '1') return {};
  return { ...seams };
}

export default seams;
