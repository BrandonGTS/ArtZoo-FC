'use client';
import Image from 'next/image';
import { Modal, type ModalProps } from 'antd';
export default function PaperModal(props: ModalProps) {
  return (
    <Modal
      centered
      closeIcon={<Image src="/artzoo/albums/close.svg" alt="关闭" width={20} height={20} />}
      {...props}
    />
  );
}
