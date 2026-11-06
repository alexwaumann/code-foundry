# Refusal toasts drop the error code in words

A store's sentinel ("failed precondition: ...", "invalid argument: ...", "not found: ...")
repeats the error's code and reaches Connect's rawMessage, so toasts opened with it. The CLI
already drops it in `invokeFailed`. `errorMessage` (`src/api/stream.ts`) now does the same,
for every surface that shows a daemon error; only a prefix at the start of the message goes.

The Actions editor had its own copy, `refusalText`, which this replaces.
