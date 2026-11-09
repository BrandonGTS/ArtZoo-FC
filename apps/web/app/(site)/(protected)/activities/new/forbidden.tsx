import { AuthFallbackBootstrap } from '../../../../../components/auth-server-snapshot';
import ForbiddenContent from '../../../../../components/system/forbidden-content';

export default function NewActivityForbidden() {
  return (
    <>
      <AuthFallbackBootstrap />
      <ForbiddenContent title="需要正式成员资格" subTitle="当前账号暂不能发布活动，只有正式成员可以发布。" />
    </>
  );
}
