// Single knob for every content-producing Claude call (Milestone 10 model
// swap, Haiku -> Sonnet). Override per-process with MEERKAT_MODEL (e.g. on
// meerkat-test) to trial another model without a code change.
module.exports = process.env.MEERKAT_MODEL || 'claude-sonnet-4-6';
