import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 不允许用 any 逃避类型检查。
      '@typescript-eslint/no-explicit-any': 'error',
      // 不允许用注释关掉类型检查；确有必要时用 @ts-expect-error 并写明原因。
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true, 'ts-nocheck': true }
      ],
      // 不允许直接插入 HTML，防止 XSS。
      'react/no-danger': 'error',
      // AntD 只从包入口导入，内部路径在升级时可能变化。
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['antd/es/*', 'antd/lib/*'],
              message: '只从 antd 包入口导入，例如 import type { ResultRef } from "antd"。'
            }
          ]
        }
      ]
    }
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts'])
]);
