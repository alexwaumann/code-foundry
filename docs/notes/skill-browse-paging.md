# Browse all pages through the whole marketplace

Skills' Browse all stopped at the first 200 hits. `SearchSkillsRequest` now takes an `offset`
(`skill.browse --offset`), and the list's last line asks for the next page when it scrolls
near the view: the list is virtualised, so mounting is the trigger, and each page's arrival
keys a new line so reaching the end again asks again. There is no "showing the first N" any
more, because the rest arrive on scrolling.

Decisions and gotchas:

- Offsets are only stable within one read of the marketplace. A page from another epoch
  would skip or repeat hits, so it is dropped and the list is read again from the top.
- A read of the same query (a row installed, a new epoch) keeps every page loaded, in pages
  of at most 500, the daemon's cap. Otherwise the list would collapse under the scroll.
- A failed page keeps what is loaded; the last line says why and offers Try again.
- A hit hidden as an installed row still counts towards the offset: it is the daemon's
  list being paged, and the page hides those rows afterwards.

The Plugins page has no paging: registries list few plugins and it filters in the client.
