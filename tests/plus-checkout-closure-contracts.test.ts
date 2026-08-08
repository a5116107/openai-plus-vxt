import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOpenAiFillBillingAction,
  isOpenAiSelectSavedCardAction,
  isOpenAiSubmitQualifiedCheckoutAction,
  isOpenAiVerifyBillingAction,
} from '../src/app/page-actions';
import { visibleAutomationSteps } from '../src/features/automation/steps';

const address = {
  fullName: 'Fixture User', line1: '1 Test St', line2: '', city: 'Seattle', state: 'WA', stateFull: 'Washington',
  postalCode: '98101', countryCode: 'US', countryLabel: 'United States', phone: '2065550100', source: 'fixture',
};

test('closure-enabled DAG replaces legacy PayPal payment steps', () => {
  const enabled = visibleAutomationSteps('email', 'email', true).map((step) => step.id);
  assert.ok(enabled.includes('run-plus-checkout-closure'));
  for (const legacy of ['create-checkout-link', 'open-checkout-link', 'submit-openai-checkout', 'fill-payment-profile']) {
    assert.equal(enabled.includes(legacy as never), false);
  }
  const disabled = visibleAutomationSteps('email', 'email', false).map((step) => step.id);
  assert.equal(disabled.includes('run-plus-checkout-closure'), false);
  assert.ok(disabled.includes('create-checkout-link'));
});

test('Saved Card, billing and submit messages accept only fixed schemas', () => {
  assert.equal(isOpenAiSelectSavedCardAction({ type: 'opx:openai-select-saved-card', expectedLast4: '4242' }), true);
  assert.equal(isOpenAiSelectSavedCardAction({ type: 'opx:openai-select-saved-card', expectedLast4: '42', selector: '*' }), false);
  assert.equal(isOpenAiFillBillingAction({ type: 'opx:openai-fill-billing', address }), true);
  assert.equal(isOpenAiVerifyBillingAction({ type: 'opx:openai-verify-billing', address }), true);
  assert.equal(isOpenAiSubmitQualifiedCheckoutAction({
    type: 'opx:openai-submit-qualified-checkout', expectedLast4: '4242', billingCountry: 'US',
    selectionVerified: true, billingVerified: true, submitKey: 'closure-fixture',
  }), true);
  assert.equal(isOpenAiSubmitQualifiedCheckoutAction({
    type: 'opx:openai-submit-qualified-checkout', expectedLast4: '4242', billingCountry: 'US',
    selectionVerified: true, billingVerified: true, submitKey: 'x', script: 'document.cookie',
  }), false);
});
