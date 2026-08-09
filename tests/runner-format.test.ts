import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeActionData } from '../src/features/automation/runner-format';

test('summarizeActionData 保持全部字段的既有顺序和文案', () => {
  const summary = summarizeActionData({
    url: 'https://chatgpt.com/checkout/session?token=hidden',
    pageKind: 'checkout',
    tabStatus: 'complete',
    navigationMs: 1260,
    loadMessage: '页面已加载',
    readyMessage: '控件已就绪',
    amountFound: true,
    amountText: 'INR 0',
    paypalButtonFound: true,
    submitButtonFound: false,
    createAccountButtonFound: true,
    emailInputFound: false,
    continueButtonFound: true,
    billingConsentButtonFound: false,
    readyState: 'interactive',
    inputFound: true,
    inputSelector: '#email',
    inputValueLength: 8,
    expectedLength: 8,
    inputMatchesExpected: true,
    fillMethod: 'native-setter',
    fillMethodOk: true,
    fillImmediateLength: 0,
    fillAfterEventLength: 8,
    fillMessage: '写入完成',
    inputReadOnly: false,
    inputDisabled: true,
    inputConnected: true,
    buttonFound: true,
    buttonText: 'Continue',
    buttonDisabled: false,
    validationText: '验证通过',
    activeElement: 'input#email',
  });

  assert.equal(summary, [
    '页面=chatgpt.com/checkout/session',
    '状态=checkout',
    '加载=complete',
    '跳转耗时=1.3s',
    '加载结果=页面已加载',
    '控件结果=控件已就绪',
    '金额=INR 0',
    'PayPal按钮=是',
    '提交按钮=否',
    '创建账户=是',
    'PayPal邮箱框=否',
    '继续按钮=是',
    '同意按钮=否',
    'ready=interactive',
    '输入框=#email',
    '值长度=8/8',
    '值匹配=是',
    '写入方式=native-setter',
    '写入成功=是',
    '写入长度=0->8',
    '写入结果=写入完成',
    '只读=否',
    '禁用=是',
    '连接=是',
    '按钮=Continue',
    '按钮禁用=否',
    '页面提示=验证通过',
    '焦点=input#email',
  ].join('；'));
});

test('summarizeActionData 保持存在但为 falsy 的字段语义', () => {
  assert.equal(summarizeActionData({
    tabStatus: '',
    navigationMs: 0,
    amountFound: false,
    readyState: '',
    inputFound: false,
    inputValueLength: 0,
    expectedLength: 0,
    fillMethodOk: false,
    fillImmediateLength: 0,
    fillAfterEventLength: 0,
    buttonFound: false,
  }), [
    '加载=未知',
    '跳转耗时=0s',
    '金额=未找到',
    'ready=',
    '输入框=未找到',
    '值长度=0/0',
    '写入成功=否',
    '写入长度=0->0',
    '按钮=未找到',
  ].join('；'));
});

test('summarizeActionData 忽略非对象与空对象', () => {
  assert.equal(summarizeActionData(null), '');
  assert.equal(summarizeActionData('checkout'), '');
  assert.equal(summarizeActionData({}), '');
});
