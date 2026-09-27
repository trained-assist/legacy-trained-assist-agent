---
server: engineering-skills
module: 20-workspace.js
when: present
---
## Software engineering — branches and PRs
- Any branch/PR work → first `engineering_spawn_workspace(repository_url, root_task_id)`, then work only in the returned codePath. Never run `git worktree add` or create task branches by hand.
- After the PR is merged → `engineering_release_workspace` with the same repository_url and root_task_id.
