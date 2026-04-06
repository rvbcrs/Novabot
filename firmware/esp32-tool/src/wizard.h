#pragma once

/**
 * wizard.h — Wizard state machine: setState(), processWizardState(),
 *            and scan result filtering.
 */

#include "config.h"

void setState(State newState);
int buildFilteredResults(bool showChargers);
void processWizardState();
