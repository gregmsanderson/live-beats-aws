import { Stack, StackProps, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface FoundationStackProps extends StackProps {
  stage: string;
  appName: string;
}

export class FoundationStack extends Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    // vpc
    // https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.VpcProps.html#interface-vpcprops
    // note: cidr is used in their example but is deprecated. Supports between /16 (65k IPs) and /28 (16 IPs).
    this.vpc = new ec2.Vpc(this, `${props.stage}-${props.appName}-vpc`, {
      //vpcName: `${props.stage}-${props.appName}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/21"), // /21 is 2048 IPs which is enough for a quick test app
      natGateways: 0, // to reduce cost
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 23, // change as needed
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 23, // change as needed
          name: "private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
  }
}
