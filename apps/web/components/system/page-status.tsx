import { AuthFallbackBootstrap } from '../auth-server-snapshot';
import { PageHeading } from '../page-heading';
import styles from './page-status.module.css';

type Props = { title: string; message: string; retry?: () => void; standalone?: boolean };
/** No auth, provider, data reads or exception object: safe even when the root layout fails. */
export default function PageStatus({ title, message, retry, standalone = false }: Props) {
  return (
    <>
      <AuthFallbackBootstrap />
      <>
        <meta name="robots" content="noindex, nofollow" />
        <main
          id="main-content"
          className={styles.page}
          style={
            standalone
              ? {
                  minHeight: '100vh',
                  display: 'grid',
                  placeItems: 'center',
                  padding: 24,
                  boxSizing: 'border-box'
                }
              : undefined
          }
        >
          <section
            className={styles.paper}
            aria-label={title}
            style={
              standalone
                ? {
                    width: '100%',
                    maxWidth: 760,
                    padding: 32,
                    boxSizing: 'border-box',
                    background: '#fffdf4',
                    border: '1px solid #c5c9b1',
                    borderRadius: 14
                  }
                : undefined
            }
          >
            <PageHeading level={1} decoration="burger">
              {title}
            </PageHeading>
            <p className={styles.message}>{message}</p>
            <div className={styles.actions}>
              {retry ? (
                <button type="button" className={styles.primary} onClick={retry}>
                  重新尝试
                </button>
              ) : null}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Root failure escape must work without a Router/Provider; use a same-origin document GET. */}
              <a className={styles.link} href="/">
                返回首页
              </a>
            </div>
          </section>
        </main>
      </>
    </>
  );
}
