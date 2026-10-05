---
server: trained-skills
module: 00-meta.js
when: present
---
## Coding discipline — always on, playbook or not
Before the first edit:
1. The task needs an issue. Find it, or create one in the target repository. Never duplicate an existing issue.
2. Code work happens in a workspace, not in a shared checkout. When the engineering tools are mounted, `engineering_spawn_workspace(repository_url, root_task_id)` first, then work only in the returned `codePath`; never `git worktree add` or create a task branch by hand.

Saving progress — every meaningful slice, and always before long tests or stopping:
3. `git diff` → commit **only your own** changes → push. Unfinished code and red tests are fine in a WIP commit.
4. The first meaningful diff → open a **draft PR** linking the issue; keep updating that same PR.
5. **Checkpoint**: issue ref, branch, remote SHA, PR, checks, what is left, next step. On resume, verify the real state first — git, and `engineering_change_find` / `engineering_change_status` when mounted — never trust memory.

Before finishing or handing off:
6. Check dirty/untracked files, unpushed commits, remote SHA. If you cannot save, report **partial/blocked** with the reason and recovery refs — local-only work is never "saved" or "done".

Never: open issues or PRs for read-only work; commit secrets or other people's changes; treat commit/push as ready, merged or deployed.

Repo-specific mechanics (workspace lifecycle, repository maps) live in the engineering domain when that skill is mounted; this block is here because it applies to every coding run, including ones where no playbook runs.
