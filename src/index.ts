import { Octokit } from '@octokit/rest';

import githubQuery from './githubQuery';
import generateBarChart from './generateBarChart';
import {
  userInfoQuery,
  createContributedRepoQuery,
  createBranchListQuery,
  createCommittedDateQuery,
} from './queries';

/**
 * 每个分支最多取多少条提交。原版是 100。
 * 提高这个值可以让统计更接近真实分布，但会增加 API 配额消耗。
 */
const PER_BRANCH_LIMIT = Number(process.env.PER_BRANCH_LIMIT || 100);

/**
 * 单次运行最多处理多少个 (仓库, 分支) 组合，防止超出 GraphQL 速率限制。
 */
const MAX_REPO_BRANCH_PAIRS = Number(process.env.MAX_REPO_BRANCH_PAIRS || 400);

interface IRepo {
  name: string;
  owner: string;
}

(async () => {
  /**
   * 1. 拿当前 token 对应的用户 id
   */
  const userResponse = await githubQuery(userInfoQuery)
    .catch(error => console.error(`Unable to get username and id\n${error}`));
  const { login: username, id } = userResponse?.data?.viewer || {};
  if (!username || !id) {
    console.error('无法获取用户信息，请检查 GH_TOKEN 是否有效（需要 repo + gist 权限）');
    process.exit(1);
  }
  console.log(`User: ${username} (id: ${id})`);

  /**
   * 2. 拿贡献过的仓库（排除 fork）
   */
  const contributedRepoQuery = createContributedRepoQuery(username);
  const repoResponse = await githubQuery(contributedRepoQuery)
    .catch(error => console.error(`Unable to get the contributed repo\n${error}`));
  const repos: IRepo[] = (repoResponse?.data?.user?.repositoriesContributedTo?.nodes || [])
    .filter((repoInfo: any) => !repoInfo?.isFork)
    .map((repoInfo: any) => ({
      name: repoInfo?.name,
      owner: repoInfo?.owner?.login,
    }));
  console.log(`Repositories contributed to (non-fork): ${repos.length}`);

  /**
   * 3. 对每个仓库，列出所有分支，并带上默认分支兜底
   */
  const repoBranchMap = await Promise.all(
    repos.map(async repo => {
      const res = await githubQuery(createBranchListQuery(repo.owner, repo.name))
        .catch(error => {
          console.error(`Unable to list branches for ${repo.owner}/${repo.name}\n${error}`);
          return null;
        });

      const node = res?.data?.repository;
      if (!node) return { repo, branches: [] as string[] };

      const names = (node.refs?.nodes || [])
        .map((n: any) => n?.name)
        .filter(Boolean) as string[];

      // 默认分支一定纳入（有些仓库 refs 分页里可能没包含，或默认分支名较特殊）
      const defaultBranch = node.defaultBranchRef?.name;
      if (defaultBranch && !names.includes(defaultBranch)) {
        names.unshift(defaultBranch);
      }

      return { repo, branches: names };
    })
  );

  const totalBranches = repoBranchMap.reduce((sum, item) => sum + item.branches.length, 0);
  console.log(`Total (repo, branch) pairs: ${totalBranches}`);

  /**
   * 4. 展平成 (repo, branch) 任务列表，并做上限截断
   */
  let tasks: Array<{ repo: IRepo; branch: string }> = [];
  for (const { repo, branches } of repoBranchMap) {
    for (const branch of branches) {
      tasks.push({ repo, branch });
    }
  }

  if (tasks.length > MAX_REPO_BRANCH_PAIRS) {
    console.log(
      `WARN: ${tasks.length} pairs exceed MAX_REPO_BRANCH_PAIRS=${MAX_REPO_BRANCH_PAIRS}, truncating.`
    );
    tasks = tasks.slice(0, MAX_REPO_BRANCH_PAIRS);
  }

  /**
   * 5. 并发查询每个 (仓库, 分支) 的提交时间。
   *    用小批量分批 + 每批之间稍作等待，避免触发二级速率限制。
   */
  let morning = 0; // 6 - 12
  let daytime = 0; // 12 - 18
  let evening = 0; // 18 - 24
  let night = 0;   // 0 - 6
  let processedCommits = 0;

  const BATCH_SIZE = 20;
  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(({ repo, branch }) =>
        githubQuery(
          createCommittedDateQuery(id, repo.name, repo.owner, branch, PER_BRANCH_LIMIT)
        ).catch(error => {
          console.error(
            `Unable to get commits for ${repo.owner}/${repo.name}@${branch}\n${error}`
          );
          return null;
        })
      )
    );

    results.forEach(res => {
      const edges = res?.data?.repository?.ref?.target?.history?.edges;
      if (!edges) return;

      edges.forEach((edge: any) => {
        const committedDate = edge?.node?.committedDate;
        if (!committedDate) return;

        const timeString = new Date(committedDate).toLocaleTimeString('en-US', {
          hour12: false,
          timeZone: process.env.TIMEZONE,
        });
        const hour = +timeString.split(':')[0];

        if (hour >= 6 && hour < 12) morning++;
        else if (hour >= 12 && hour < 18) daytime++;
        else if (hour >= 18 && hour < 24) evening++;
        else night++;

        processedCommits++;
      });
    });

    // 轻微节流，保护速率限制
    if (i + BATCH_SIZE < tasks.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`Commits analyzed: ${processedCommits}`);

  /**
   * 6. 生成图表文本
   */
  const sum = morning + daytime + evening + night;
  if (!sum) {
    console.log('没有统计到任何提交，跳过 gist 更新。');
    return;
  }

  const oneDay = [
    { label: '🌞 Morning', commits: morning },
    { label: '🌆 Daytime', commits: daytime },
    { label: '🌃 Evening', commits: evening },
    { label: '🌙 Night', commits: night },
  ];

  const lines = oneDay.reduce<string[]>((prev, cur) => {
    const percent = (cur.commits / sum) * 100;
    const line = [
      `${cur.label}`.padEnd(10),
      `${cur.commits.toString().padStart(5)} commits`.padEnd(14),
      generateBarChart(percent, 21),
      String(percent.toFixed(1)).padStart(5) + '%',
    ];

    return [...prev, line.join(' ')];
  }, []);

  /**
   * 7. 写入 gist
   */
  const octokit = new Octokit({
    auth: `token ${process.env.GH_TOKEN}`,
    ...(process.env.PB_OCTOKIT_BASE ? { baseUrl: process.env.PB_OCTOKIT_BASE } : {}),
  });
  const gist = await octokit.gists
    .get({ gist_id: process.env.GIST_ID as string })
    .catch(error => console.error(`Unable to update gist\n${error}`));
  if (!gist) return;

  const filename = Object.keys(gist.data.files!)[0];
  await octokit.gists.update({
    gist_id: process.env.GIST_ID as string,
    files: {
      [filename]: {
        filename: morning + daytime > evening + night ? "I'm an early 🐤" : "I'm a night 🦉",
        content: lines.join('\n'),
      },
    },
  });

  console.log('Gist updated.');
})();
