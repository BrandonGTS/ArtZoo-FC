'use client';

import { useRef, useState, type CSSProperties } from 'react';
import PaperModal from '../../../components/ui/paper-modal';
import home from '../home/home-preview.module.css';
import type { PreviewAlbum } from './album-preview-content';
import styles from './album-preview.module.css';

const colors = ['var(--photo)', 'var(--cover)', 'var(--line)', 'var(--wish)'];
const ratios = [1.5, 0.75, 1, 16 / 9, 2 / 3];

export default function AlbumPhotos({ album }: { album: PreviewAlbum }) {
  const grid = useRef<HTMLUListElement>(null);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const last = album.count - 1;

  function move(step: number) {
    setIndex((current) => Math.max(0, Math.min(last, current + step)));
  }

  return (
    <>
      <ul className={styles.photos} aria-label="照片缩略图" ref={grid}>
        {Array.from({ length: album.count }, (_, i) => (
          <li key={i}>
            <button
              type="button"
              aria-label={'查看第 ' + (i + 1) + ' 张照片'}
              style={{ backgroundColor: i === 0 ? album.color : colors[i % colors.length] }}
              onClick={() => {
                setIndex(i);
                setOpen(true);
              }}
            >
              <span aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
            </button>
          </li>
        ))}
      </ul>
      <PaperModal
        open={open}
        title={album.name}
        footer={null}
        width="min(64rem, calc(100% - 1rem))"
        className={home.previewDialog + ' ' + styles.viewer}
        styles={{ container: { background: 'var(--cream)' }, header: { background: 'transparent' } }}
        onCancel={() => setOpen(false)}
        afterClose={() => grid.current?.children[index]?.querySelector('button')?.focus()}
        wrapProps={{
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            move(event.key === 'ArrowLeft' ? -1 : 1);
          }
        }}
      >
        <div className={styles.stage}>
          <span
            role="img"
            aria-label={album.name + '，第 ' + (index + 1) + ' 张'}
            style={
              {
                '--photo-ratio': ratios[index % ratios.length],
                backgroundColor: index === 0 ? album.color : colors[index % colors.length]
              } as CSSProperties
            }
          />
        </div>
        <div className={styles.controls}>
          <button type="button" disabled={index === 0} onClick={() => move(-1)}>
            上一张
          </button>
          <span role="status">
            {index + 1} / {album.count}
          </span>
          <button type="button" disabled={index === last} onClick={() => move(1)}>
            下一张
          </button>
        </div>
      </PaperModal>
    </>
  );
}
