# glw – GitLab Pipeline Watch

A Cinnamon panel applet (Linux Mint) that shows at a glance whether a CI pipeline is
currently running in any of your GitLab instances – so you know when it is safe to deploy.

It watches every GitLab host you are logged in to with [`glab`](https://gitlab.com/gitlab-org/cli)
(e.g. gitlab.com, a self-hosted instance and your company's instance at the same time).
No tokens are stored by the applet; it simply reuses glab's authentication.

## Quick start

```bash
# 1. Requirements
sudo apt install glab python3 libnotify-bin   # or install glab from its release page

# 2. Log in to each GitLab instance (a token with scope "read_api" is enough)
glab auth login --hostname gitlab.example.com

# 3. Install the applet
git clone https://github.com/hansmaulwurf23/glw.git
cd glw && ./install.sh
```

4. Right-click the panel → **Applets** → add **GitLab Pipeline Watch**.
5. Optional: right-click the icon → **Configure…** to restrict hosts or tune intervals.

## Icons

| Icon | Meaning |
|---|---|
| grey dash | nothing going on |
| blue, blinking (+ count) | pipeline(s) running or pending → **do not deploy yet** |
| green play | pipeline done, waiting for a manual job (e.g. deploy) |
| green check | latest pipeline passed |
| red cross | latest pipeline failed |
| yellow ! | error while querying |

- **Left click** opens a menu with running / waiting / recently finished pipelines; clicking an entry opens it in the browser.
- **Middle click** refreshes immediately.
- A desktop notification is shown when a pipeline finishes (“All pipelines done – you can deploy now.”).

## Settings

| Setting | Default | |
|---|---|---|
| GitLab hosts | *(empty)* | comma separated; empty = every glab host that has a token |
| Project activity window | 7 days | only projects you are a member of with recent activity are checked |
| Show finished pipelines for | 60 min | |
| Only pipelines triggered by me | on | filters by the user who started the pipeline (push, MR, manual run, own schedules) |
| Username(s) | *(empty)* | empty = user logged in via glab; or `alice` for all hosts; or `gitlab.example.com=alice, git.company.com=bob` |
| Poll interval idle / busy | 60 s / 15 s | |
| Show count, blink, notifications | on | |

## How it works

`glw@hansmaulwurf23/glw-status.py` (Python standard library only) does the work:

1. Reads the hosts from glab's `~/.config/glab-cli/config.yml` (or uses the configured list).
2. Gets the token per host via `glab config get token --host <host>`
   (fallback: environment variable `GITLAB_TOKEN_<HOST>`, e.g. `GITLAB_TOKEN_GITLAB_EXAMPLE_COM`).
3. Lists projects you are a member of that were active recently and have CI/CD enabled,
   then fetches the latest 5 pipelines of each (in parallel).
4. Prints JSON, which the applet (`applet.js`) turns into icon, tooltip and menu.

You can run the helper on its own for debugging:

```bash
python3 'glw@hansmaulwurf23/glw-status.py' --hosts gitlab.example.com | python3 -m json.tool
```

Note: pipelines started only by a schedule are noticed only if the project shows other
activity within the activity window – increase it if needed.

## Troubleshooting

- Menu shows `no token` → run `glab auth login --hostname <host>`.
- `N project queries failed: HTTP Error 403` → your role in that project may not allow reading pipelines.
- Applet errors: Looking Glass (`Alt+F2` → `lg`) or `~/.xsession-errors`.

## License

MIT
