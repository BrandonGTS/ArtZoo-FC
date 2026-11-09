import HomeContent from '../../../../../components/home-content';
import InvitationRegistration from '../../../../../components/invitation/invitation-registration';
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <>
      <HomeContent />
      <InvitationRegistration token={token} />
    </>
  );
}
