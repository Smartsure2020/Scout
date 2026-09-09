// Production-safe default. The synthetic QA flag is supplied only by the
// preview Worker wrapper, never by a public query parameter.
window.ScoutQAConfig = Object.freeze({
  fixtureMode: false,
  baseUrl: "",
  label: "",
});
