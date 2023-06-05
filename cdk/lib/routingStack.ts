import { Stack, StackProps, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as cdk from "aws-cdk-lib/core";
import * as elasticloadbalancingv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as globalaccelerator from "aws-cdk-lib/aws-globalaccelerator";
import * as globalaccelerator_endpoints from "aws-cdk-lib/aws-globalaccelerator-endpoints";

export interface RoutingStackProps extends StackProps {
  stage: string;
  appName: string;
  vpc: ec2.Vpc;
  ecsLoadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer;
}

export class RoutingStack extends Stack {
  constructor(scope: Construct, id: string, props: RoutingStackProps) {
    super(scope, id, props);

    const accelerator = new globalaccelerator.Accelerator(
      this,
      `${props.stage}-${props.appName}-accelerator`,
      {
        //acceleratorName: `${props.stage}-${props.appName}-accelerator`,
      }
    );

    const acceleratorListener = accelerator.addListener(
      `${props.stage}-${props.appName}-accelerator-listener`,
      {
        //listenerName: `${props.stage}-${props.appName}-accelerator-listener`,
        clientAffinity: globalaccelerator.ClientAffinity.SOURCE_IP,
        portRanges: [{ fromPort: 80 }],
      }
    );

    acceleratorListener.addEndpointGroup(
      `${props.stage}-${props.appName}-accelerator-listener-group1`,
      {
        healthCheckInterval: Duration.seconds(5),
        healthCheckPath: "/signin",
        healthCheckThreshold: 1,
        healthCheckProtocol: globalaccelerator.HealthCheckProtocol.HTTP,
        //region: process.env.MAIN_REGION,
        endpoints: [
          new globalaccelerator_endpoints.ApplicationLoadBalancerEndpoint(
            props.ecsLoadBalancer,
            { preserveClientIp: true, weight: 128 }
          ),
        ],
      }
    );

    // show hostname
    new cdk.CfnOutput(this, "Accelerator hostname", {
      value: accelerator.dnsName,
    });
  }
}
