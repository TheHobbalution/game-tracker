game-tracker/ (repo root, live at https://thehobbalution.github.io/game-tracker/)

Location            File                    Purpose
(root)              index.html              The app itself, Style B look (master copy: data combine\game-tracker.html)
(root)              classic.html            The old look, frozen: new data, no new features (master: data combine\game-tracker-classic.html)
(root)              style-b.html            Redirect to ./ so old Style B links still work
(root)              games-*.json, summaries.json, config.json, club-stats.json, details/, data.json.gz
                                            Published data from publish.js (copy publish-out\* here; publish-out also holds index.html and classic.html)
tracker/            game-tracker.html       Redirect so the old link still works
scripts/            playhq_scrape.mjs       Pull raw data from PlayHQ
scripts/            playhq_to_tracker.mjs   Convert raw data to an importable xlsx
(root)              .gitignore              Keeps generated files (and Style B) out of git
(root)              .gitattributes          Git line-ending config

Local only, never pushed: game-tracker-b.html and preview-style-b.bat (Style B preview).
