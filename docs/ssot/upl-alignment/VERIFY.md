# VERIFY.md







Filled during/after implementation.







| ID | Result | Evidence |



|---|---|---|



| T-P0-01 | PASS | `ProbeTaskConfig` fields in types.ts; DEFAULT + normalizeTaskConfig in state.ts include stagedPipelineEnabled/promotionCountry/bootstrapCountry/providerCountry/requireZero/enablePromotionUpdate/enableProviderTaxes/useSelectedAsBootstrapProvider |



| T-P0-02 | PASS | service.ts `resolveStagedCountries` + `runStagedCheckoutForCountry` `onBeforeStage` → `applyProbeProxy(task, stageCountry)` for bootstrap/promotion/provider |



| T-P0-03 | PASS | checkout.ts `runStagedCheckoutPipeline` create→update→taxes; probeAccountCountry branches when stagedPipelineEnabled |



| T-P0-04 | PASS | checkout pipeline requireZero reject + probe service double-check with isZeroAmountValue / zeroLikely / hitKind |



| T-P0-05 | PASS | automation-settings HTML ids probe-staged-pipeline/require-zero/promotion/bootstrap/provider + fillProbePanel + collectProbeTaskConfig |



| T-P0-06 | PASS | tsc --noEmit clean; static SSOT checks ALL PASS; package 0.0.12; dist/openai-plus-vxt-0.0.12-mullvad.xpi + .xpi; built chunk/background contain staged strings |







## Commands







```text



pnpm exec tsc --noEmit   # exit 0



pnpm zip:firefox         # openai-plus-vxt-0.0.12-firefox.zip



```







## Package







- dist/openai-plus-vxt-0.0.12-mullvad.xpi



- dist/openai-plus-vxt-0.0.12.xpi



- version: 0.0.12 (package.json + wxt.config.ts)







## Runtime note







- Default stagedPipelineEnabled=false keeps old single-create path.



- Enable in 自动化设置 → 探测任务：勾选「启用 UPL 三阶段」。



- Default promotion country VN; useSelectedAsBootstrapProvider=true maps selected country to bootstrap+provider.





## P1 results (0.0.13)



| ID | Result | Evidence |

|---|---|---|

| T-P1-01 | PASS | src/features/payment/methods.ts profiles for hosted/paypal/ideal/upi/pix/blik/twint/kakao + stage defaults |

| T-P1-02 | PASS | final-url.ts pattern/next_action extract; stripe-confirm.ts optional payment_methods + payment_pages/confirm |

| T-P1-03 | PASS | proxy types methodPools/preferMethodPools; state pickMethodStageProxy; probe onBeforeStage uses pool first |

| T-P1-04 | PASS | probe config extractFinalPaymentUrl/stripe pk/method; automation-settings controls + method pool textareas |

| T-P1-05 | PASS | tsc clean; static checks ALL PASS; dist/openai-plus-vxt-0.0.13-mullvad.xpi; build smoke strings present |



### Commands

- pnpm exec tsc --noEmit (exit 0)

- pnpm zip:firefox -> 0.0.13



### Package

- dist/openai-plus-vxt-0.0.13-mullvad.xpi

- dist/openai-plus-vxt-0.0.13.xpi


## P2 results (0.0.14)

| ID | Result | Evidence |
|---|---|---|
| T-P2-01 | PASS | payment/detect-methods.ts Stripe payment_pages init + payment_method_types extract; ignores card/paypal/link |
| T-P2-02 | PASS | proxy/seed-health.ts record/cooldown/remove; pickMethodStageProxy filters cooling/removed; probe records stage seed outcomes and purges removed lines |
| T-P2-03 | PASS | probe config detectPaymentMethods/attachDetectedMethods; UI toggles + seed cooldown params + seed health board |
| T-P2-04 | PASS | tsc clean; runtime checks ALL PASS; dist/openai-plus-vxt-0.0.14-mullvad.xpi; build smoke strings present |

### Commands
- pnpm exec tsc --noEmit (exit 0)
- pnpm zip:firefox -> 0.0.14

### Package
- dist/openai-plus-vxt-0.0.14-mullvad.xpi
- dist/openai-plus-vxt-0.0.14.xpi

## UX results (0.0.15)

| ID | Result | Evidence |
|---|---|---|
| T-UX-01 | PASS | methodDetections storage + buildCountryMethodRecommendations + probe-methods-table board |
| T-UX-02 | PASS | exportSeedHealthCsv/Json + UI export buttons |
| T-UX-03 | PASS | autoApplyDetectedMethods uses detected supported methods only; apply-recommended button |
| T-UX-04 | PASS | tsc clean; runtime checks PASS; dist/openai-plus-vxt-0.0.15-mullvad.xpi |

### Package
- dist/openai-plus-vxt-0.0.15-mullvad.xpi
- dist/openai-plus-vxt-0.0.15.xpi
