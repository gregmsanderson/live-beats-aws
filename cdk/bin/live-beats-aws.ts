#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { FoundationStack } from "../lib/foundationStack";
import { DatabaseStack } from "../lib/databaseStack";
import { AppStack } from "../lib/appStack";

// environment
const envPrimaryRegion = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const stage = "staging";
const appName = "live-beats";

// app stack
console.log("Using AWS account/region: " + JSON.stringify(envPrimaryRegion));

const app = new cdk.App();

const foundationStack = new FoundationStack(app, "foundation-stack", {
  env: envPrimaryRegion,
  stage: stage,
  appName: appName,
});

const databaseStack = new DatabaseStack(app, "database-stack", {
  env: envPrimaryRegion,
  stage: stage,
  appName: appName,
  vpc: foundationStack.vpc,
});

const appStack = new AppStack(app, "app-stack", {
  env: envPrimaryRegion,
  stage: stage,
  appName: appName,
  vpc: foundationStack.vpc,
  databaseCredentialsSecretArn: databaseStack.databaseCredentialsSecretArn,
  database: databaseStack.database,
});
