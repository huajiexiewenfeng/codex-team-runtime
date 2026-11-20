// Production delivery is deliberately unavailable until a supported host integration
// proves non-interrupting enqueue semantics on the exact deployed host/build.
// Reading idle then sending is not a safe adapter.
export const unavailableWatchdogAdapter = Object.freeze({
 capability: Object.freeze({status:'unavailable',reason:'safe-non-interrupting-host-adapter-not-verified'}),
});
// A private WeakSet prevents an arbitrary JSON capability/observation from enabling
// production sends. The only implemented adapter is isolated, fixture-only.
const fixtures=new WeakSet();
export function fixtureWatchdogAdapter(enqueue) {
 if(typeof enqueue!=='function')throw new Error('Fixture enqueue function required');
 const adapter=Object.freeze({capability:Object.freeze({status:'fixture-only'}),enqueue});fixtures.add(adapter);return adapter;
}
export function watchdogAdapterAllowed(adapter,state) {
 return fixtures.has(adapter)&&state.team.source.kind==='fixture'&&state.events.every(e=>e.source.kind==='fixture');
}
