export const previewPages = [
  { id: 'home', href: '/preview/home', label: '首页' },
  { id: 'daily', href: '/preview/daily', label: '日常' },
  { id: 'activities', href: '/preview/activities', label: '活动' },
  { id: 'album', href: '/preview/album', label: '相册' },
  { id: 'share', href: '/preview/share', label: '其他' }
] as const;

export type PreviewPage = (typeof previewPages)[number];
