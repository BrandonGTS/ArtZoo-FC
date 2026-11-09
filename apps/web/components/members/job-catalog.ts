// Original PNG assets: approved ArtZoo Figma file jR5jiwJ9dAiBd6oraJVT8O, node 734:9662.
export const JOB_GROUPS = [
  {
    label: '坦克',
    jobs: [
      {
        name: '骑士',
        icon: '/artzoo/jobs/paladin.png'
      },
      {
        name: '战士',
        icon: '/artzoo/jobs/warrior.png'
      },
      {
        name: '暗黑骑士',
        icon: '/artzoo/jobs/dark-knight.png'
      },
      {
        name: '绝枪战士',
        icon: '/artzoo/jobs/gunbreaker.png'
      }
    ]
  },
  {
    label: '治疗',
    jobs: [
      {
        name: '白魔法师',
        icon: '/artzoo/jobs/white-mage.png'
      },
      {
        name: '学者',
        icon: '/artzoo/jobs/scholar.png'
      },
      {
        name: '占星术士',
        icon: '/artzoo/jobs/astrologian.png'
      },
      {
        name: '贤者',
        icon: '/artzoo/jobs/sage.png'
      }
    ]
  },
  {
    label: '输出',
    jobs: [
      {
        name: '武僧',
        icon: '/artzoo/jobs/monk.png'
      },
      {
        name: '龙骑士',
        icon: '/artzoo/jobs/dragoon.png'
      },
      {
        name: '忍者',
        icon: '/artzoo/jobs/ninja.png'
      },
      {
        name: '武士',
        icon: '/artzoo/jobs/samurai.png'
      },
      {
        name: '钐镰客',
        icon: '/artzoo/jobs/reaper.png'
      },
      {
        name: '蝰蛇剑士',
        icon: '/artzoo/jobs/viper.png'
      },
      {
        name: '吟游诗人',
        icon: '/artzoo/jobs/bard.png'
      },
      {
        name: '机工士',
        icon: '/artzoo/jobs/machinist.png'
      },
      {
        name: '舞者',
        icon: '/artzoo/jobs/dancer.png'
      },
      {
        name: '黑魔法师',
        icon: '/artzoo/jobs/black-mage.png'
      },
      {
        name: '召唤师',
        icon: '/artzoo/jobs/summoner.png'
      },
      {
        name: '赤魔法师',
        icon: '/artzoo/jobs/red-mage.png'
      },
      {
        name: '绘灵法师',
        icon: '/artzoo/jobs/pictomancer.png'
      }
    ]
  }
] as const;
export const JOBS = JOB_GROUPS.flatMap((group) => [...group.jobs]);
export function toggleJob(values: string[], name: string): string[] {
  return values.includes(name) ? values.filter((value) => value !== name) : [...values, name];
}
