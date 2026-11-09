import Image from 'next/image';
import { stickerParts } from './sticker-codec';
import './stickers.css';
export default function StickerText({ text }: { text: string }) {
  return (
    <>
      {stickerParts(text).map((part, index) =>
        typeof part === 'string' ? (
          part
        ) : (
          <Image
            key={index}
            className="artzoo-sticker"
            src={part.url}
            width={part.width}
            height={part.height}
            alt={'[' + part.label + ']'}
            title={part.label}
            unoptimized
            loading="lazy"
          />
        )
      )}
    </>
  );
}
