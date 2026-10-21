-- A wake subscription's note (docs/notes/ember-fixes-2-timers.md): why the subscriber
-- asked to be woken, given with `thread subscribe --note`, carried by the wake and shown
-- by `thread subscriptions` and Ember's board. '' for none.
ALTER TABLE thread_subscriptions ADD COLUMN note TEXT NOT NULL DEFAULT '';
