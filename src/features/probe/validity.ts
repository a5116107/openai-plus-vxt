import type {
  ProbeExperimentValidityStatus,
  ProbeObservation,
  ProbeServerCredentialStatus,
  ProbeStageExitSnapshot,
} from './types';

export interface ProbeTreatmentValidityInput {
  plannedAuthCountry: string;
  plannedCheckoutCountry: string;
  plannedBillingCountry: string;
  plannedPaymentMethod: string;
  submittedPaymentMethod: string;
  credentialStatus: ProbeServerCredentialStatus;
  outcome: ProbeObservation['outcome'];
  auth: ProbeStageExitSnapshot;
  checkout: ProbeStageExitSnapshot;
  billing: ProbeStageExitSnapshot;
}

export interface ProbeTreatmentValidity {
  actualAuthCountry: string;
  actualCheckoutCountry: string;
  actualBillingCountry: string;
  countryTreatmentApplied: boolean;
  routeTreatmentApplied: boolean;
  paymentMethodTreatmentApplied: boolean;
  experimentValidityStatus: ProbeExperimentValidityStatus;
  experimentValidForAttribution: boolean;
  experimentValidityReasons: string[];
}

export function evaluateProbeTreatmentValidity(input: ProbeTreatmentValidityInput): ProbeTreatmentValidity {
  const plannedAuth = country(input.plannedAuthCountry);
  const plannedCheckout = country(input.plannedCheckoutCountry);
  const plannedBilling = country(input.plannedBillingCountry);
  const actualAuth = country(input.auth.country);
  const actualCheckout = country(input.checkout.country);
  const actualBilling = country(input.billing.country);
  const plannedMethod = method(input.plannedPaymentMethod);
  const submittedMethod = method(input.submittedPaymentMethod);

  const countryTreatmentApplied = Boolean(
    plannedCheckout
    && input.checkout.verified
    && actualCheckout
    && actualCheckout === plannedCheckout,
  );
  const authApplied = !plannedAuth || Boolean(input.auth.verified && actualAuth === plannedAuth);
  const billingApplied = !plannedBilling || Boolean(input.billing.verified && actualBilling === plannedBilling);
  const routeTreatmentApplied = countryTreatmentApplied && authApplied && billingApplied;
  const paymentMethodTreatmentApplied = !plannedMethod || Boolean(submittedMethod && submittedMethod === plannedMethod);
  const reasons: string[] = [];

  if (input.outcome === 'error') reasons.push('outcome-error');
  if (input.credentialStatus === 'invalid') reasons.push('credential-invalid');
  if (!input.checkout.verified) reasons.push('checkout-exit-unverified');
  if (plannedCheckout && actualCheckout && actualCheckout !== plannedCheckout) reasons.push('checkout-country-mismatch');
  if (plannedCheckout && !actualCheckout) reasons.push('checkout-country-missing');
  if (!authApplied) reasons.push(input.auth.verified ? 'auth-country-mismatch' : 'auth-exit-unverified');
  if (!billingApplied) reasons.push(input.billing.verified ? 'billing-country-mismatch' : 'billing-exit-unverified');
  if (plannedMethod && !submittedMethod) reasons.push('payment-method-not-submitted');
  else if (plannedMethod && submittedMethod !== plannedMethod) reasons.push('payment-method-mismatch');

  const experimentValidForAttribution = input.outcome !== 'error'
    && input.credentialStatus !== 'invalid'
    && countryTreatmentApplied;
  const experimentValidityStatus: ProbeExperimentValidityStatus = !experimentValidForAttribution
    ? 'invalid'
    : routeTreatmentApplied && paymentMethodTreatmentApplied
      ? 'valid'
      : 'partial';

  return {
    actualAuthCountry: actualAuth,
    actualCheckoutCountry: actualCheckout,
    actualBillingCountry: actualBilling,
    countryTreatmentApplied,
    routeTreatmentApplied,
    paymentMethodTreatmentApplied,
    experimentValidityStatus,
    experimentValidForAttribution,
    experimentValidityReasons: [...new Set(reasons)],
  };
}

export function isObservationAttributionEligible(item: ProbeObservation): boolean {
  return item.experimentValidForAttribution !== false
    && item.outcome !== 'error'
    && item.credentialStatus !== 'invalid'
    && item.countryTreatmentApplied !== false;
}

function country(value: string): string {
  return String(value || '').trim().toUpperCase();
}

function method(value: string): string {
  return String(value || '').trim().toLowerCase();
}
