// Gate tests: verify the tool stays out of the prompt until explicitly unlocked.
import { apply, IMAGE_RELAY_TOOL_NAME, IMAGE_RELAY_COMMAND_NAME } from '../src/index.js';

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { if (ok) { pass++; console.log('  ok   ' + label + (extra ? ' :: ' + extra : '')); } else { fail++; console.log('  FAIL ' + label + (extra ? ' :: ' + extra : '')); } };

/** Build a mock DSH context recording global vs per-agent tool registration. */
function makeHarness() {
  const globalTools = new Map();
  const agentRestrictions = [];
  const commands = new Map();
  const commandRegistrations = [];

  const makeAgent = (id) => ({});

  const baseCtx = {
    logger: { info: (...a) => console.log('    [log]', ...a), warn: (...a) => console.log('    [warn]', ...a) },
    tools: {
      register(def) { globalTools.set(def.name, def); return () => globalTools.delete(def.name); }
    },
    attachments: { imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1e9, maxMessageImageBytes: 1e9 } },
    credentials: { async resolve() { return undefined; }, async readRecord() { return undefined; } },
    inject(names, cb) {
      return cb({
        commands: {
          register(def) { commandRegistrations.push(def); commands.set(def.name, def); return () => commands.delete(def.name); }
        }
      });
    }
  };

  return {
    baseCtx,
    globalTools,
    commands,
    commandRegistrations,
    agentRestrictions,
    makeAgentContext(id) {
      const scoped = new Map();
      return {
        scoped,
        ctx: {
          tools: {
            register(def) { scoped.set(def.name, def); return () => scoped.delete(def.name); },
            restrict(filter) { agentRestrictions.push({ id, filter }); return () => {}; }
          }
        }
      };
    },
    agents: new Map()
  };
}

console.log('--- defaultLocked: true (the PTC-safe default) ---');
{
  const h = makeHarness();
  apply(h.baseCtx, {});
  check('no global tool registered', h.globalTools.size === 0, 'global=' + [...h.globalTools.keys()].join(','));
  check('command registered', h.commands.has(IMAGE_RELAY_COMMAND_NAME));
  const cmd = h.commands.get(IMAGE_RELAY_COMMAND_NAME);

  const agent = { id: 'a1' };
  const sc = h.makeAgentContext('a1');
  agent.ctx = sc.ctx;

  const before = cmd.handler({ agent, rawInput: 'status' });
  check('status reports locked', before.text.includes('已锁定'), before.text);
  check('still no agent-scoped tool', sc.scoped.size === 0);

  const on = cmd.handler({ agent, rawInput: 'on' });
  check('on succeeds', on.kind === 'success', on.text);
  check('tool now registered in AGENT scope', sc.scoped.has(IMAGE_RELAY_TOOL_NAME), 'scoped=' + [...sc.scoped.keys()].join(','));
  check('tool still NOT global', h.globalTools.size === 0);

  const again = cmd.handler({ agent, rawInput: 'on' });
  check('second on is idempotent', again.text.includes('已处于解锁状态'), again.text);

  const st = cmd.handler({ agent, rawInput: 'status' });
  check('status reports unlocked', st.text.includes('已解锁'), st.text);

  const off = cmd.handler({ agent, rawInput: 'off' });
  check('off succeeds', off.kind === 'success', off.text);
  check('tool removed from agent scope', sc.scoped.size === 0);
  check('no restriction used when deployment is locked', h.agentRestrictions.length === 0);

  const bad = cmd.handler({ agent, rawInput: 'nonsense' });
  check('unknown verb is an error', bad.kind === 'error', bad.text);
}

console.log('--- two sessions are independent ---');
{
  const h = makeHarness();
  apply(h.baseCtx, {});
  const cmd = h.commands.get(IMAGE_RELAY_COMMAND_NAME);
  const a1 = { id: 'a1' }, a2 = { id: 'a2' };
  const s1 = h.makeAgentContext('a1'); a1.ctx = s1.ctx;
  const s2 = h.makeAgentContext('a2'); a2.ctx = s2.ctx;

  cmd.handler({ agent: a1, rawInput: 'on' });
  check('a1 unlocked', s1.scoped.has(IMAGE_RELAY_TOOL_NAME));
  check('a2 NOT unlocked', s2.scoped.size === 0);
  const s2status = cmd.handler({ agent: a2, rawInput: 'status' });
  check('a2 status stays locked', s2status.text.includes('已锁定'), s2status.text);
}

console.log('--- defaultLocked: false (opt-in global) ---');
{
  const h = makeHarness();
  apply(h.baseCtx, { defaultLocked: false });
  check('tool registered globally', h.globalTools.has(IMAGE_RELAY_TOOL_NAME));
  const cmd = h.commands.get(IMAGE_RELAY_COMMAND_NAME);
  const a1 = { id: 'a1' };
  const s1 = h.makeAgentContext('a1'); a1.ctx = s1.ctx;

  const off = cmd.handler({ agent: a1, rawInput: 'off' });
  check('off restricts inherited global', h.agentRestrictions.length === 1 && h.agentRestrictions[0].filter.deny.includes(IMAGE_RELAY_TOOL_NAME),
    JSON.stringify(h.agentRestrictions));
  const st = cmd.handler({ agent: a1, rawInput: 'status' });
  check('status reports locked after off', st.text.includes('已锁定'), st.text);

  cmd.handler({ agent: a1, rawInput: 'on' });
  check('on lifts the restriction (no scoped duplicate)', s1.scoped.size === 0, 'scoped=' + [...s1.scoped.keys()].join(','));
  const st2 = cmd.handler({ agent: a1, rawInput: 'status' });
  check('status reports unlocked again', st2.text.includes('已解锁'), st2.text);
}

console.log('--- enabled: false ---');
{
  const h = makeHarness();
  apply(h.baseCtx, { enabled: false });
  check('nothing registered', h.globalTools.size === 0 && h.commands.size === 0);
}

console.log('\ngate tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
