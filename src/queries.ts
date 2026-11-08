export const userInfoQuery = `
  query {
    viewer {
      login
      id
    }
  }
`;

export const createContributedRepoQuery = (username: string) => `
  query {
    user(login: "${username}") {
      repositoriesContributedTo(last: 100, includeUserRepositories: true) {
        nodes {
          isFork
          name
          owner {
            login
          }
        }
      }
    }
  }
`;

/**
 * 查询一个仓库里作者本人的提交时间。
 *
 * 关键改动（相比原版）：
 * 1. 用 `defaultBranchRef` 取代硬编码的 `ref(qualifiedName: "master")`，
 *    这样 main / master / 其他默认分支名都能命中。
 * 2. 通过 `refs(refPrefix: "refs/heads/", first: 100)` 列出该仓库的所有分支，
 *    逐个分支查提交，做到「统计所有分支」。
 * 3. `history(first: PER_BRANCH_LIMIT)` 支持翻页，采样窗口更大。
 */
export const createBranchListQuery = (owner: string, name: string) => `
  query {
    repository(owner: "${owner}", name: "${name}") {
      defaultBranchRef {
        name
      }
      refs(refPrefix: "refs/heads/", first: 100, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
        nodes {
          name
        }
      }
    }
  }
`;

export const createCommittedDateQuery = (
  id: string,
  name: string,
  owner: string,
  branch: string,
  limit: number = 100,
) => `
  query {
    repository(owner: "${owner}", name: "${name}") {
      ref(qualifiedName: "${branch}") {
        target {
          ... on Commit {
            history(first: ${limit}, author: { id: "${id}" }) {
              edges {
                node {
                  committedDate
                }
              }
            }
          }
        }
      }
    }
  }
`;
