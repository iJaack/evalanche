// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title AgentEscrow
 * @notice Escrow contract for agent-to-agent service payments.
 *         Client deposits ETH when hiring an agent. Funds release on completion
 *         or refund after timeout.
 */
contract AgentEscrow {
    enum Status { Active, Completed, Refunded, Disputed, Resolved }

    struct Escrow {
        address client;
        address agent;
        uint256 amount;
        uint256 deadline;
        Status status;
    }

    address public owner;
    uint256 public defaultTimeout;
    mapping(bytes32 => Escrow) public escrows;

    event JobCreated(bytes32 indexed jobId, address indexed client, address indexed agent, uint256 amount, uint256 deadline);
    event JobCompleted(bytes32 indexed jobId, uint256 amount);
    event JobRefunded(bytes32 indexed jobId, uint256 amount);
    event JobDisputed(bytes32 indexed jobId, address disputedBy);
    event DisputeResolved(bytes32 indexed jobId, uint256 clientShare, uint256 agentShare);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(uint256 _defaultTimeout) {
        owner = msg.sender;
        defaultTimeout = _defaultTimeout;
    }

    /**
     * @notice Deposit ETH into escrow for a job
     * @param jobId Unique job identifier (keccak256 hash of marketplace job ID)
     * @param agent The service provider's address
     * @param timeout Custom timeout in seconds (0 = use default)
     */
    function createJob(bytes32 jobId, address agent, uint256 timeout) external payable {
        require(msg.value > 0, "Must deposit ETH");
        require(agent != address(0), "Invalid agent");
        require(agent != msg.sender, "Cannot hire yourself");
        require(escrows[jobId].client == address(0), "Job already exists");

        uint256 deadline = block.timestamp + (timeout > 0 ? timeout : defaultTimeout);

        escrows[jobId] = Escrow({
            client: msg.sender,
            agent: agent,
            amount: msg.value,
            deadline: deadline,
            status: Status.Active
        });

        emit JobCreated(jobId, msg.sender, agent, msg.value, deadline);
    }

    /**
     * @notice Release escrowed funds to the agent (called by client)
     * @param jobId The job to complete
     */
    function completeJob(bytes32 jobId) external {
        Escrow storage e = escrows[jobId];
        require(e.client == msg.sender, "Not client");
        require(e.status == Status.Active, "Not active");

        e.status = Status.Completed;
        uint256 amount = e.amount;

        (bool sent, ) = e.agent.call{value: amount}("");
        require(sent, "Transfer failed");

        emit JobCompleted(jobId, amount);
    }

    /**
     * @notice Refund client after deadline (called by client)
     * @param jobId The job to refund
     */
    function refund(bytes32 jobId) external {
        Escrow storage e = escrows[jobId];
        require(e.client == msg.sender, "Not client");
        require(e.status == Status.Active, "Not active");
        require(block.timestamp >= e.deadline, "Deadline not reached");

        e.status = Status.Refunded;
        uint256 amount = e.amount;

        (bool sent, ) = e.client.call{value: amount}("");
        require(sent, "Transfer failed");

        emit JobRefunded(jobId, amount);
    }

    /**
     * @notice Mark job as disputed (called by client or agent)
     * @param jobId The job to dispute
     */
    function disputeJob(bytes32 jobId) external {
        Escrow storage e = escrows[jobId];
        require(e.status == Status.Active, "Not active");
        require(msg.sender == e.client || msg.sender == e.agent, "Not party");

        e.status = Status.Disputed;

        emit JobDisputed(jobId, msg.sender);
    }

    /**
     * @notice Resolve a dispute by splitting funds (owner only)
     * @param jobId The disputed job
     * @param clientShare Amount to send to client (remainder goes to agent)
     */
    function resolveDispute(bytes32 jobId, uint256 clientShare) external onlyOwner {
        Escrow storage e = escrows[jobId];
        require(e.status == Status.Disputed, "Not disputed");
        require(clientShare <= e.amount, "Share exceeds amount");

        e.status = Status.Resolved;
        uint256 agentShare = e.amount - clientShare;

        if (clientShare > 0) {
            (bool sent1, ) = e.client.call{value: clientShare}("");
            require(sent1, "Client transfer failed");
        }
        if (agentShare > 0) {
            (bool sent2, ) = e.agent.call{value: agentShare}("");
            require(sent2, "Agent transfer failed");
        }

        emit DisputeResolved(jobId, clientShare, agentShare);
    }

    /**
     * @notice Read escrow details for a job
     * @param jobId The job to query
     */
    function getEscrow(bytes32 jobId) external view returns (
        address client,
        address agent,
        uint256 amount,
        uint256 deadline,
        Status status
    ) {
        Escrow storage e = escrows[jobId];
        return (e.client, e.agent, e.amount, e.deadline, e.status);
    }
}
