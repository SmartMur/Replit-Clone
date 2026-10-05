# Starter templates

Static pages written with the bm-design-system classes. The agent starts new sites from these via the `use_template` tool.

| id | what it is |
|----|------------|
| landing | marketing page: header, hero, outcomes, steps, FAQ, call-to-action, footer |
| app-dashboard | app shell + header, metric cards, activity list, callout |
| auth | log in, sign up, forgot password (front end only) |
| settings | app shell + form, preference toggles, danger zone |
| admin-table | app shell + searchable list with badges and pagination |

- Structures (app shell, centered auth card, page header, divided list rows) are modelled on https://github.com/buildermethods/build-new at ddddef8. No files were copied; the build-new repo has no LICENSE file (README: free to use, fork, adapt).
- Every editable string is a `{{placeholder}}`. `complete_build` is blocked while any remain in .html or .js.
- Tested unfilled in a real browser: 0 console errors, Lighthouse accessibility 100, no horizontal overflow at 375px.
- To add one: create `templates/<id>/` with `template.json` (`id`, `name`, `description`, `bestFor`, `files`) and the files.
