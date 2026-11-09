'use client';
import { useEffect } from 'react';
import AlbumBrowser from '../../albums/album-browser';
import AlbumDetail from '../../albums/album-detail';
import { ALBUM_DEMO_ID, ALBUM_DEMO_PHOTO_ID } from './albums-fixtures';
export { albumDemoResponse } from './albums-fixtures';
export const ALBUM_HELP_STEPS = [
  {
    key: 'album-create',
    title: '创建一本相册',
    description: '填写相册名称、分类、上传权限与可见范围。上传权限默认仅创建者上传。',
    selector: '.album-editor-modal .ant-modal-container'
  },
  {
    key: 'album-menu',
    title: '相册右上角的管理菜单',
    description: '从三角菜单修改相册、进入批量操作，或按当前权限删除相册。',
    selector: '.operation-menu-popup[aria-label="相册管理操作"]'
  },
  {
    key: 'album-bulk',
    title: '批量处理照片',
    description: '选择需要处理的照片，使用批量删除；完成后退出批量操作。',
    selector: '.album-detail-bulk-actions'
  },
  {
    key: 'album-photo-tools',
    title: '缩放与切换照片',
    description: '使用照片下方工具栏放大、缩小、按原始尺寸查看或适应窗口，并用左右箭头切换照片。',
    selector: '.album-photo-toolbar'
  },
  {
    key: 'album-photo-thumbnails',
    title: '从缩略图选择照片',
    description: '下方缩略图展示这本相册的照片，选中其中一张即可切换查看。',
    selector: '.album-photo-filmstrip'
  },
  {
    key: 'album-photo-information',
    title: '照片信息与操作',
    description: '这里显示上传者、区服与上传时间，右侧三角菜单显示当前账号可用的照片操作。',
    selector: '.album-photo-author'
  },
  {
    key: 'album-photo-comments',
    title: '照片评论入口',
    description: '从照片信息区下方的评论入口填写留言，与大家交流这张照片。',
    selector: '.album-photo-discussion .daily-bottom-composer'
  }
];
/** Drives only existing local UI controls; business requests are isolated by the iframe demo host. */
export default function AlbumsDemo({ current }: { current: number }) {
  useEffect(() => {
    if (current >= 3) return;
    let stopped = false;
    const prepare = () => {
      if (stopped) return;
      if (current === 0) {
        if (document.querySelector('.album-editor-modal')) return;
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.album-page-heading button')
        ).find((item) => item.textContent === '创建相册');
        if (button) {
          stopped = true;
          button.click();
        }
      } else {
        if (current === 2 && document.querySelector('.album-detail-bulk-actions')) return;
        const popup = document.querySelector('.operation-menu-popup[aria-label="相册管理操作"]');
        if (popup && current === 2) {
          const button = Array.from(popup.querySelectorAll<HTMLButtonElement>('button')).find(
            (item) => item.textContent === '批量操作'
          );
          if (button) {
            stopped = true;
            button.click();
          }
          return;
        }
        const trigger = document.querySelector<HTMLButtonElement>(
          '.album-detail-menu button[aria-label="相册管理操作"]'
        );
        if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      }
    };
    const observer = new MutationObserver(prepare);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-expanded']
    });
    prepare();
    return () => {
      stopped = true;
      observer.disconnect();
    };
  }, [current]);
  return current === 0 ? (
    <AlbumBrowser key="create" />
  ) : (
    <AlbumDetail
      key={current}
      id={ALBUM_DEMO_ID}
      initialPhoto={current >= 3 ? ALBUM_DEMO_PHOTO_ID : undefined}
    />
  );
}
