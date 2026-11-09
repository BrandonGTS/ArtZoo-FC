'use client';
import { BrowserInputPolicy } from './browser-input-policy';

import { ConfigProvider, type ThemeConfig } from 'antd';
import { UserOperationProvider } from './user-operation-provider';
import zhCN from 'antd/locale/zh_CN';
// DatePicker derives month names from Day.js, separately from AntD's UI locale.
import 'dayjs/locale/zh-cn';
import ControlFocusProvider from './control-focus-provider';
import { controlFocusShadows, selectFocusOutline } from './control-focus-theme';
import { AuthSessionProvider } from './auth-session';
import SiteHelpProvider from './site-help/site-help-provider';
import DemoBootstrap from './site-help/demo-bootstrap';
import { QuickLinksStateProvider } from './quick-links/quick-links-state';
import { MessageStateProvider } from './messages/message-state';
import { ActivityEditFeedbackProvider } from './activities/activity-edit-feedback';

// Shared visual foundation and server-backed account session.
const artzooTheme: ThemeConfig = {
  token: {
    colorPrimary: '#436B4E',
    colorPrimaryHover: '#34583F',
    colorPrimaryActive: '#25432F',
    colorSuccess: '#326846',
    colorWarning: '#79561A',
    colorError: '#A34335',
    colorInfo: '#315F67',
    colorText: '#24372B',
    colorTextHeading: '#254B38',
    colorTextSecondary: '#58614F',
    colorTextDisabled: '#828578',
    colorBorder: '#78816A',
    colorBorderSecondary: '#C5C9B1',
    colorSplit: '#C5C9B1',
    colorBgBase: '#FFFDF4',
    colorBgContainer: '#FFFDF4',
    colorBgElevated: '#FFFDF4',
    colorBgLayout: '#FAF2DF',
    colorBgMask: '#00000040',
    colorBgContainerDisabled: '#E4E3D8',
    colorFillSecondary: '#E4EBD8',
    colorLink: '#436B4E',
    colorLinkHover: '#34583F',
    colorLinkActive: '#25432F',
    fontFamily: '"Patrick Hand", "Xiaolai", sans-serif',
    fontSize: 16,
    lineHeight: 26 / 16,
    fontWeightStrong: 400,
    borderRadius: 12,
    controlHeight: 40,
    controlHeightLG: 40,
    boxShadow: '0 6px 10px rgba(37, 75, 56, .10)',
    boxShadowSecondary: '0 6px 16px rgba(37, 75, 56, .18)'
  },
  components: {
    Input: controlFocusShadows,
    InputNumber: controlFocusShadows,
    DatePicker: controlFocusShadows,
    Select: selectFocusOutline,
    Button: {
      contentFontSize: 16,
      contentFontSizeLG: 16,
      primaryColor: '#FFFDF4',
      defaultBg: '#FFFDF4',
      defaultColor: '#436B4E',
      defaultBorderColor: '#78816A',
      defaultHoverBg: '#EFF2E5',
      defaultHoverColor: '#34583F',
      defaultHoverBorderColor: '#436B4E',
      defaultActiveBg: '#DCE5CF',
      defaultActiveColor: '#25432F',
      defaultActiveBorderColor: '#25432F',
      defaultBgDisabled: '#E4E3D8',
      textHoverBg: 'transparent',
      linkHoverBg: 'transparent',
      textTextColor: '#436B4E',
      textTextHoverColor: '#34583F',
      textTextActiveColor: '#25432F',
      fontWeight: 400,
      defaultShadow: 'none',
      primaryShadow: 'none',
      paddingInline: 16
    },
    Menu: {
      itemBg: 'transparent',
      itemColor: '#24372B',
      itemHoverColor: '#254B38',
      itemHoverBg: '#E4EBD8',
      itemSelectedColor: '#254B38',
      itemSelectedBg: '#E4EBD8',
      itemActiveBg: '#E4EBD8',
      itemBorderRadius: 12,
      itemHeight: 40,
      itemPaddingInline: 16,
      itemMarginInline: 4,
      itemMarginBlock: 4,
      horizontalItemBorderRadius: 12,
      horizontalItemSelectedBg: '#E4EBD8',
      horizontalItemSelectedColor: '#254B38',
      horizontalItemHoverBg: '#E4EBD8',
      horizontalItemHoverColor: '#254B38',
      horizontalLineHeight: '46px',
      dropdownWidth: 208,
      activeBarHeight: 2,
      activeBarWidth: 36,
      popupBg: '#FFFDF4',
      dangerItemColor: '#B8493A',
      dangerItemHoverColor: '#943C30',
      dangerItemActiveBg: 'transparent'
    },
    Avatar: { containerSize: 40, textFontSize: 16, colorTextLightSolid: '#254B38' },
    Card: { borderRadiusLG: 14, bodyPadding: 24, headerFontSize: 24, headerHeight: 56 },
    Dropdown: { paddingBlock: 4, controlItemBgHover: '#E4EBD8', colorTextLightSolid: '#FFFDF4' },
    Modal: { titleFontSize: 24, titleLineHeight: 34 / 24 }
  }
};

export default function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ConfigProvider locale={zhCN} theme={artzooTheme} button={{ autoInsertSpace: false }}>
      <UserOperationProvider>
        <BrowserInputPolicy />
        <ControlFocusProvider />
        <AuthSessionProvider>
          <SiteHelpProvider>
            <MessageStateProvider>
              <ActivityEditFeedbackProvider>
                <DemoBootstrap>
                  <QuickLinksStateProvider>{children}</QuickLinksStateProvider>
                </DemoBootstrap>
              </ActivityEditFeedbackProvider>
            </MessageStateProvider>
          </SiteHelpProvider>
        </AuthSessionProvider>
      </UserOperationProvider>
    </ConfigProvider>
  );
}
