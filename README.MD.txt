game-tracker/ (top-level folder)

	tracker/ (subfolder)
		game-tracker.html — the app itself
		data.json — the published data snapshot (add this once you export it — must live right here, next 		to the html file)

	scripts/ (subfolder)
		playhq_scrape.mjs — pulls raw data from PlayHQ
		playhq_to_tracker.mjs — converts that into an importable file


README.md — explains all of the above
.gitignore
.gitattributes






Or as a quick table:

Location	File			Purpose
tracker/	game-tracker.html	The app you open/host
tracker/	data.json		Published data for the live site to auto-load
scripts/	playhq_scrape.mjs	Pull raw data from PlayHQ
scripts/	playhq_to_tracker.mjs	Convert raw data → importable xlsx
(root)		README.md		Explains the whole repo
(root)		.gitignore		Keeps generated files out of git
(root)		.gitattributes		Git line-ending config (auto-added)