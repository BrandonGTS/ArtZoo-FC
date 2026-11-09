type HeadingDecoration = 'burger' | 'tomato' | 'cheese' | 'patty';

export function PageHeading({
  children,
  level = 2,
  decoration
}: {
  children: React.ReactNode;
  level?: 1 | 2;
  decoration: HeadingDecoration;
}) {
  const Tag = level === 1 ? 'h1' : 'h2';
  return (
    <div className={`page-heading heading-${level}`}>
      <span className={`food-decoration food-${decoration}`} aria-hidden />
      <Tag>{children}</Tag>
    </div>
  );
}
