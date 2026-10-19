-- Plugin wake sources (internal/store/thread/subscriptions_plugin.go,
-- docs/notes/plugins-wake-sources.md): target_kind 'plugin' with target_id
-- "<plugin>/<source>" and condition 'fired'. args is the subscription's args as a JSON
-- object of strings (given, defaulted or taken from the subscriber's context); '{}' for
-- every other target.
ALTER TABLE thread_subscriptions ADD COLUMN args TEXT NOT NULL DEFAULT '{}';
